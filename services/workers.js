const cron = require('node-cron');
const User = require('../models/User');
const AutoPostConfig = require('../models/AutoPostConfig');
const NotificationSettings = require('../models/NotificationSettings');
const { fetchLocationReviews, publishPostToGoogle, getValidAccessToken } = require('./gbpService');
const { generate2LineAIReply, generateAutoPostText, generateAiPosterSvg } = require('./geminiAI');

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

// 1. Auto-Reply Worker (Every 5 mins)
cron.schedule('*/5 * * * *', async () => {
  console.log('[Auto-Reply Worker] Running periodic check for unanswered reviews across Pro locations...');
  try {
    const users = await User.find({
      locations: { $elemMatch: { subscriptionStatus: 'pro', autoReplyEnabled: true } }
    });

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

        console.log(`[Auto-Reply] Processing reviews for business: ${loc.locationName || parentPath}`);
        const reviewData = await fetchLocationReviews(user, '', parentPath);
        const unreplied = (reviewData.reviews || []).filter(r => !r.reviewReply);

        for (const review of unreplied) {
          const reviewerName = review.reviewer?.displayName || 'Customer';
          const starVal = review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 : review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1;
          
          const replyText = await generate2LineAIReply(loc.locationName, reviewerName, starVal, review.comment || '', supportEmail, supportPhone);

          if (replyText) {
            const validToken = await getValidAccessToken(user);
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
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Reply Worker Error]:', err.message);
  }
});

// 2. Auto-Post Worker (Every 15 mins)
cron.schedule('*/15 * * * *', async () => {
  console.log('[Auto-Post Worker] Checking active configurations...');
  try {
    const activeConfigs = await AutoPostConfig.find({ enabled: true });
    if (!activeConfigs.length) return;

    const now = new Date();
    const istTimeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    const [currentHour, currentMinute] = istTimeStr.split(':').map(Number);
    const currentTotalMinutes = currentHour * 60 + currentMinute;

    for (const config of activeConfigs) {
      const [prefHour, prefMinute] = (config.preferredTime || '10:00').split(':').map(Number);
      const prefTotalMinutes = prefHour * 60 + prefMinute;

      // Catches custom times (like 2:20) in the closest 15-minute cron execution
      const diff = currentTotalMinutes - prefTotalMinutes;
      if (diff < 0 || diff >= 15) continue;

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
        const diffInDays = (now - new Date(config.lastPostedAt)) / (1000 * 60 * 60 * 24);
        if (config.frequency === 'daily' && diffInDays >= 1) shouldPublish = true;
        if (config.frequency === 'weekly' && diffInDays >= 7) shouldPublish = true;
        if (config.frequency === 'biweekly' && diffInDays >= 14) shouldPublish = true;
      }

      if (shouldPublish) {
        const businessName = targetLocation.locationName || 'Our Business';
        console.log(`[Auto-Post] Processing scheduled post for business: ${businessName}`);

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
      }
    }
  } catch (err) {
    console.error('[Auto-Post Worker Error]:', err.message);
  }
});

module.exports = {};
