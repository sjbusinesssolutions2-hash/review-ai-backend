const cron = require('node-cron');
const User = require('../models/User');
const AutoPostConfig = require('../models/AutoPostConfig');
const NotificationSettings = require('../models/NotificationSettings');
const { fetchLocationReviews, publishPostToGoogle, getValidAccessToken } = require('./gbpService');
const { generate2LineAIReply, generateAutoPostText, generateAiPosterSvg } = require('./geminiAI');

// Helper delay utility to space out heavy API calls and prevent memory spikes
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Overlap guards to prevent concurrent runs
let isAutoReplyRunning = false;
let isAutoPostRunning = false;

async function sendCriticalReviewAlert(targetEmail, locationName, reviewerName, starRating, comment, replyText) {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: [targetEmail],
        subject: `🚨 Critical Review Alert (${starRating} Stars) - ${locationName}`,
        html: `
          <h3>A low rating review was received on Google Maps for ${locationName}.</h3>
          <p><strong>Reviewer:</strong> ${reviewerName}</p>
          <p><strong>Rating:</strong> ${starRating} Stars</p>
          <p><strong>Comment:</strong> ${comment || 'No comment provided'}</p>
          <hr />
          <p><strong>Automated AI Reply Sent:</strong></p>
          <p><em>"${replyText}"</em></p>
        `
      })
    });
    if (!response.ok) throw new Error('Failed to send email via Resend API');
  } catch (error) {
    console.error('[Email Alert Error]:', error.message);
  }
}

// Helper function to get IST date string (YYYY-MM-DD)
function getISTDateString(dateObj) {
  return new Date(dateObj).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Helper function to compare calendar days in IST
function isSameDayIST(d1, d2) {
  return getISTDateString(d1) === getISTDateString(d2);
}

// Helper to get current IST hour & minute safely
function getCurrentISTMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

// 1. Auto-Reply Worker (Every 5 mins)
cron.schedule('*/5 * * * *', async () => {
  if (isAutoReplyRunning) return;
  isAutoReplyRunning = true;

  try {
    const users = await User.find({
      locations: { $elemMatch: { subscriptionStatus: 'pro', autoReplyEnabled: true } }
    });

    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;

    for (const user of users) {
      if (!user.accessToken && !user.refreshToken) continue;

      const settings = await NotificationSettings.findOne({ userId: user._id });
      const supportEmail = settings?.supportEmail || '';
      const supportPhone = settings?.supportPhone || '';
      const isCriticalEmailEnabled = settings?.criticalAlerts?.email !== false;

      for (const loc of user.locations) {
        if (loc.subscriptionStatus !== 'pro' || !loc.autoReplyEnabled) continue;
        const parentPath = loc.accountLocationPath;
        if (!parentPath) continue;

        const reviewData = await fetchLocationReviews(user, '', parentPath, 10);
        const unreplied = (reviewData.reviews || []).filter(r => {
          if (r.reviewReply) return false;
          if (!r.createTime) return false;
          return new Date(r.createTime).getTime() >= cutoffMs;
        });

        if (unreplied.length === 0) continue;

        console.log(`[Auto-Reply] Found ${unreplied.length} unreplied review(s) for Pro location: ${loc.locationName || parentPath}`);

        const batch = unreplied.slice(0, 4);
        const validToken = await getValidAccessToken(user);

        for (const review of batch) {
          try {
            const reviewerName = review.reviewer?.displayName || 'Customer';
            const starVal = review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 : review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1;

            const replyText = await generate2LineAIReply(loc.locationName, reviewerName, starVal, review.comment || '', supportEmail, supportPhone);

            if (replyText) {
              const googleRes = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews/${review.reviewId}/reply`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment: replyText })
              });

              if (googleRes.ok) {
                console.log(`[Auto-Reply Success] Replied to review for business: ${loc.locationName || parentPath}`);
                if (starVal <= 3 && isCriticalEmailEnabled && user.email) {
                  await sendCriticalReviewAlert(user.email, loc.locationName, reviewerName, starVal, review.comment || '', replyText);
                }
              } else {
                console.error(`[Auto-Reply Failed] Could not reply for business: ${loc.locationName || parentPath}`);
              }
            }
          } catch (reviewErr) {
            console.error(`[Auto-Reply Error] Failed processing review for ${loc.locationName || parentPath}:`, reviewErr.message);
          }

          await sleep(3000);
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Reply Worker Error]:', err.message);
  } finally {
    isAutoReplyRunning = false;
  }
});

// 2. Auto-Post Worker (Every 15 mins: :00, :15, :30, :45)
cron.schedule('*/15 * * * *', async () => {
  if (isAutoPostRunning) return;
  isAutoPostRunning = true;

  const now = new Date();
  const { hour: currentHour, minute: currentMinute, totalMinutes: currentTotalMinutes } = getCurrentISTMinutes(now);
  const formattedIST = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')} IST`;
  console.log(`[Auto-Post Worker] Checking active configurations at ${formattedIST}...`);

  try {
    const activeConfigs = await AutoPostConfig.find({ enabled: true });
    if (!activeConfigs.length) return;

    for (const config of activeConfigs) {
      const [prefHour, prefMinute] = (config.preferredTime || '10:00').split(':').map(Number);
      if (Number.isNaN(prefHour) || Number.isNaN(prefMinute)) continue;

      const prefTotalMinutes = prefHour * 60 + prefMinute;

      // Not due yet today (e.g. set for 15:43, current check is 15:30) -> wait for 15:45 tick
      if (currentTotalMinutes < prefTotalMinutes) continue;

      const user = await User.findById(config.userId);
      if (!user || (!user.accessToken && !user.refreshToken)) continue;

      const targetLocation = (user.locations || []).find(
        l => l.locationId === config.businessId || l.accountLocationPath?.includes(config.businessId)
      );

      if (!targetLocation || !targetLocation.accountLocationPath) continue;

      let shouldPublish = false;
      if (!config.lastPostedAt) {
        shouldPublish = true;
      } else {
        const lastPosted = new Date(config.lastPostedAt);
        const diffInDays = (now - lastPosted) / (1000 * 60 * 60 * 24);

        // Once preferredTime has passed today, publish on the very next 15-min tick if not already posted today
        if (config.frequency === 'daily' && !isSameDayIST(now, lastPosted)) {
          shouldPublish = true;
        } else if (config.frequency === 'weekly' && !isSameDayIST(now, lastPosted) && diffInDays >= 6.5) {
          shouldPublish = true;
        } else if (config.frequency === 'biweekly' && !isSameDayIST(now, lastPosted) && diffInDays >= 13.5) {
          shouldPublish = true;
        }
      }

      if (shouldPublish) {
        const businessName = targetLocation.locationName || 'Our Business';
        console.log(`[Auto-Post] Processing scheduled post for "${businessName}" (Scheduled: ${config.preferredTime}, Triggered: ${formattedIST})`);

        try {
          const postText = await generateAutoPostText(businessName, 'Local Business', config.topics, config.enableFestivals, config.enableReviewSpotlights);
          const svgContent = await generateAiPosterSvg(businessName, 'Local Business', config.topics, config.enableFestivals);

          if (!svgContent) continue;

          const newHistoryEntry = { postText, svgContent, publishedAt: now, status: 'PENDING' };
          config.history.push(newHistoryEntry);
          await config.save();
          const savedHistoryItem = config.history[config.history.length - 1];

          const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://review-ai-backend-03sb.onrender.com';
          const publicPngUrl = `${baseUrl}/api/auto-posts/banner/${savedHistoryItem._id}.png`;

          const publishResult = await publishPostToGoogle(user, targetLocation.accountLocationPath, postText, publicPngUrl);

          if (publishResult.success) {
            savedHistoryItem.status = 'LIVE';
            savedHistoryItem.imageUrl = publicPngUrl;
            savedHistoryItem.googlePostId = publishResult.googlePostId || null;
            config.lastPostedAt = now;
            await config.save();
            console.log(`[Auto-Post Success] Successfully published post for business: ${businessName}`);
          } else {
            savedHistoryItem.status = 'FAILED';
            savedHistoryItem.errorDetails = publishResult.error;
            await config.save();
            console.error(`[Auto-Post Failed] Failed for business: ${businessName} -`, publishResult.error);
          }
        } catch (postError) {
          console.error(`[Auto-Post Error] Processing error for business ${businessName}:`, postError.message);
        }

        // Wait 3 seconds between client posts to avoid Gemini API rate limits and Sharp memory spikes
        await sleep(3000);
      }
    }
  } catch (err) {
    console.error('[Auto-Post Worker Error]:', err.message);
  } finally {
    isAutoPostRunning = false;
  }
});

module.exports = {};
