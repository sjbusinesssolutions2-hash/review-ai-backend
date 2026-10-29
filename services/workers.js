const cron = require('node-cron');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const AutoPostConfig = require('../models/AutoPostConfig');
const NotificationSettings = require('../models/NotificationSettings');
const { fetchLocationReviews, publishPostToGoogle } = require('./gbpService');
const { generate2LineAIReply, generateAutoPostText, generateAiPosterSvg } = require('./geminiAI');

// Configure Nodemailer transporter using environment variables
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Helper function to send email alerts to user's account email
async function sendCriticalReviewAlert(toEmail, businessName, reviewerName, starRating, comment, aiReply) {
  if (!toEmail) return;

  const mailOptions = {
    from: `"SJbs.AI Alerts" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `🚨 Critical Review Alert (${starRating} Stars) - ${businessName}`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2 style="color: #dc2626;">New Low Rating Alert</h2>
        <p>A <strong>${starRating}-star review</strong> was posted for <strong>${businessName}</strong>.</p>
        
        <div style="background: #f9fafb; padding: 15px; border-left: 4px solid #dc2626; margin: 15px 0;">
          <p><strong>Reviewer:</strong> ${reviewerName}</p>
          <p><strong>Rating:</strong> ${'⭐'.repeat(starRating)}</p>
          <p><strong>Comment:</strong> "${comment || 'No comment provided'}"</p>
        </div>

        <h3>Automated AI Response Posted to Google:</h3>
        <p style="font-style: italic; background: #eff6ff; padding: 12px; border-radius: 8px;">"${aiReply}"</p>

        <p style="font-size: 12px; color: #6b7280; margin-top: 20px;">
          This email was sent to your registered account address (${toEmail}).
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Email Alert] Critical review notification sent to user account email: ${toEmail}`);
  } catch (err) {
    console.error('[Email Alert] Failed to send email notification:', err.message);
  }
}

// 1. 24/7 Automated Background Auto-Reply Worker for Pro Businesses
cron.schedule('*/5 * * * *', async () => {
  console.log('[Auto-Reply Worker] === STARTING PERIODIC REVIEW CHECK ===');
  try {
    const users = await User.find({
      locations: {
        $elemMatch: {
          subscriptionStatus: 'pro',
          autoReplyEnabled: true
        }
      }
    });

    console.log(`[Auto-Reply Worker] Found ${users.length} user(s) matching Pro + AutoReply query.`);

    for (const user of users) {
      console.log(`[Auto-Reply Worker] Inspecting user ID: ${user._id}, hasAccessToken: ${!!user.accessToken}`);
      if (!user.accessToken) {
        console.log(`[Auto-Reply Worker] SKIPPED USER: Missing accessToken.`);
        continue;
      }

      const settings = await NotificationSettings.findOne({ userId: user._id });
      const supportEmail = settings?.supportEmail || '';
      const supportPhone = settings?.supportPhone || '';
      const isCriticalEmailEnabled = settings?.criticalAlerts?.email !== false;

      for (const loc of user.locations) {
        console.log(`[Auto-Reply Worker] Checking location: "${loc.locationName}", status: "${loc.subscriptionStatus}", autoReply: ${loc.autoReplyEnabled}`);

        if (loc.subscriptionStatus !== 'pro' || !loc.autoReplyEnabled) continue;

        const parentPath = loc.accountLocationPath;
        console.log(`[Auto-Reply Worker] parentPath for ${loc.locationName}: "${parentPath}"`);
        if (!parentPath) continue;

        const pathParts = parentPath.split('/');
        const accountName = `${pathParts[0]}/${pathParts[1]}`;
        const locationName = `${pathParts[2]}/${pathParts[3]}`;

        console.log(`[Auto-Reply Worker] Fetching reviews from Google for account: ${accountName}, location: ${locationName}`);
        const reviewData = await fetchLocationReviews(user.accessToken, accountName, locationName);
        console.log(`[Auto-Reply Worker] Fetched raw reviews count: ${reviewData.reviews ? reviewData.reviews.length : 0}`);

        const unreplied = (reviewData.reviews || []).filter(r => !r.reviewReply);
        console.log(`[Auto-Reply Worker] Unreplied reviews count: ${unreplied.length}`);

        for (const review of unreplied) {
          console.log(`[Auto-Reply Worker] Processing review ID: ${review.reviewId}, Rating: ${review.starRating}`);
          const reviewerName = review.reviewer && review.reviewer.displayName ? review.reviewer.displayName : 'Customer';
          const starVal = review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 : review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1;
          
          const replyText = await generate2LineAIReply(
            loc.locationName, 
            reviewerName, 
            starVal, 
            review.comment || '', 
            supportEmail, 
            supportPhone
          );

          console.log(`[Auto-Reply Worker] Generated AI reply: "${replyText}"`);

          if (replyText) {
            const googleRes = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews/${review.reviewId}/reply`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ comment: replyText })
            });

            console.log(`[Auto-Reply Worker] Google reply API response status: ${googleRes.status}`);

            if (googleRes.ok) {
              console.log(`[Auto-Reply Worker] Successfully replied automatically for location: ${loc.locationName}`);

              if (starVal <= 3 && isCriticalEmailEnabled && user.email) {
                console.log(`[Auto-Reply Worker] Triggering critical review email alert to: ${user.email}`);
                await sendCriticalReviewAlert(
                  user.email,
                  loc.locationName,
                  reviewerName,
                  starVal,
                  review.comment || '',
                  replyText
                );
              }
            } else {
              const errBody = await googleRes.text();
              console.error(`[Auto-Reply Worker] Failed to post reply to Google: ${errBody}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Reply Worker] CRITICAL EXCEPTION:', err.message, err.stack);
  }
});

// 2. Scheduled Auto-Post Worker
cron.schedule('*/15 * * * *', async () => {
  console.log('[Auto-Post Worker] Checking active configurations...');
  try {
    const activeConfigs = await AutoPostConfig.find({ enabled: true });
    
    const now = new Date();
    const istTimeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    const [currentHour, currentMinute] = istTimeStr.split(':').map(Number);
    const currentTotalMinutes = currentHour * 60 + currentMinute;

    for (const config of activeConfigs) {
      const [prefHour, prefMinute] = (config.preferredTime || '10:00').split(':').map(Number);
      const prefTotalMinutes = prefHour * 60 + prefMinute;

      const diff = currentTotalMinutes - prefTotalMinutes;
      const isTimeMatch = diff >= 0 && diff < 15;
      
      if (!isTimeMatch) continue;

      const user = await User.findById(config.userId);
      if (!user || !user.accessToken) continue;

      const targetLocation = (user.locations || []).find(l => l.locationId === config.businessId);
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
        console.log(`[Auto-Post Worker] Attempting scheduled post for ${targetLocation.locationName}...`);

        const bName = targetLocation.locationName || 'Our Business';
        const bCat = 'Local Business';

        try {
          const postText = await generateAutoPostText(
            bName,
            bCat,
            config.topics,
            config.enableFestivals,
            config.enableReviewSpotlights
          );

          const svgContent = await generateAiPosterSvg(
            bName,
            bCat,
            config.topics,
            config.enableFestivals
          );

          if (!svgContent) {
            throw new Error('AI Banner generation returned empty SVG content.');
          }

          const newHistoryEntry = {
            postText: postText,
            svgContent: svgContent,
            publishedAt: now,
            status: 'PENDING'
          };
          
          config.history.push(newHistoryEntry);
          await config.save();
          const savedHistoryItem = config.history[config.history.length - 1];

          const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://review-ai-backend-03sb.onrender.com';
          const publicPngUrl = `${baseUrl}/api/auto-posts/banner/${savedHistoryItem._id}.png`;

          const publishResult = await publishPostToGoogle(
            user.accessToken,
            targetLocation.accountLocationPath,
            postText,
            publicPngUrl
          );

          if (publishResult.success) {
            savedHistoryItem.status = 'LIVE';
            savedHistoryItem.imageUrl = publicPngUrl;
            savedHistoryItem.googlePostId = publishResult.googlePostId || null;
            
            config.lastPostedAt = now;
            await config.save();

            console.log(`[Auto-Post Worker] Successfully published image post for ${targetLocation.locationName}.`);
          } else {
            savedHistoryItem.status = 'FAILED';
            savedHistoryItem.imageUrl = publicPngUrl;
            savedHistoryItem.errorDetails = publishResult.error;
            await config.save();

            console.error(`[Auto-Post Worker] Failed to publish post for ${targetLocation.locationName}:`, publishResult.error);
          }

        } catch (innerErr) {
          console.error(`[Auto-Post Worker] Critical generation error for ${targetLocation.locationName}:`, innerErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Post Worker] Error during scheduled post run:', err.message);
  }
});
