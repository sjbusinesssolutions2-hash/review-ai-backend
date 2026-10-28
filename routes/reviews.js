const express = require('express');
const router = express.Router();
const User = require('../models/User');
const NotificationSettings = require('../models/NotificationSettings');
const { generate2LineAIReply } = require('../services/geminiAI');

router.get('/all', async (req, res) => {
  const { userId, businessId } = req.query;

  if (!userId || !businessId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'User or access token not found' });
    }

    // Load offline support contact info
    const settings = await NotificationSettings.findOne({ userId });
    const supportEmail = settings?.supportEmail || '';
    const supportPhone = settings?.supportPhone || '';

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const targetBusinessName = targetLocation ? targetLocation.locationName : 'Our Business';
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;
    const isPro = targetLocation && targetLocation.subscriptionStatus === 'pro';

    let rawReviews = [];

    try {
      const response = await fetch(`[https://mybusiness.googleapis.com/v4/$](https://mybusiness.googleapis.com/v4/$){parentPath}/reviews`, {
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const fetchedReviews = data.reviews || [];

        rawReviews = fetchedReviews.map(r => ({
          reviewId: r.reviewId,
          reviewerName: (r.reviewer && r.reviewer.displayName) ? r.reviewer.displayName : 'Google User',
          starRating: r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1,
          comment: r.comment || '',
          reply: r.reviewReply ? r.reviewReply.comment : null,
          updateTime: r.updateTime || ''
        }));
      }
    } catch (err) {
      console.warn('[API /reviews/all] Reviews Google API fetch error:', err.message);
    }

    let userModified = false;
    let freeRepliesCount = user.freeRepliesUsed || 0;

    const processedReviews = await Promise.all(
      rawReviews.map(async (item) => {
        let aiDraftReply = '';

        if (!item.reply) {
          let existingDraft = user.savedDrafts.find(d => d.reviewId === item.reviewId);

          if (existingDraft && existingDraft.draftText) {
            aiDraftReply = existingDraft.draftText;
          } else {
            let canGenerate = isPro || freeRepliesCount < 2;

            if (canGenerate) {
              const generated = await generate2LineAIReply(
                targetBusinessName,
                item.reviewerName,
                item.starRating,
                item.comment,
                supportEmail,
                supportPhone
              );

              if (generated) {
                aiDraftReply = generated;
                user.savedDrafts.push({
                  reviewId: item.reviewId,
                  draftText: aiDraftReply
                });
                userModified = true;

                if (!isPro) {
                  freeRepliesCount++;
                  user.freeRepliesUsed = freeRepliesCount;
                }
              }
            }
          }
        }

        return {
          ...item,
          aiDraftReply
        };
      })
    );

    if (userModified) {
      await user.save();
    }

    const needsReplyCount = processedReviews.filter(r => !r.reply).length;
    const repliedCount = processedReviews.filter(r => r.reply).length;

    res.json({
      reviews: processedReviews,
      counts: {
        needsYou: needsReplyCount,
        all: processedReviews.length,
        replied: repliedCount
      },
      isPro,
      freeRepliesUsed: freeRepliesCount
    });
  } catch (err) {
    console.error('[API /reviews/all] CRITICAL ERROR:', err.message);
    res.status(500).json({ error: 'Server error fetching reviews' });
  }
});

router.post('/dismiss', async (req, res) => {
  const { userId, reviewId } = req.body;
  if (!userId || !reviewId) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.savedDrafts = user.savedDrafts.filter(d => d.reviewId !== reviewId);
    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error dismissing task' });
  }
});

router.post('/reply', async (req, res) => {
  const { userId, businessId, reviewId, replyText } = req.body;

  if (!userId || !businessId || !reviewId || !replyText || replyText.trim() === '') {
    return res.status(400).json({ error: 'Missing required parameters or empty reply text' });
  }

  try {
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'Unauthorized user access' });
    }

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;

    const googleRes = await fetch(`[https://mybusiness.googleapis.com/v4/$](https://mybusiness.googleapis.com/v4/$){parentPath}/reviews/${reviewId}/reply`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${user.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: replyText })
    });

    if (googleRes.ok) {
      const responseData = await googleRes.json();
      user.savedDrafts = user.savedDrafts.filter(d => d.reviewId !== reviewId);
      await user.save();

      return res.json({ success: true, reply: responseData });
    } else {
      const errorText = await googleRes.text();
      return res.status(googleRes.status).json({ error: 'Failed to post reply to Google Business Profile' });
    }
  } catch (err) {
    console.error('Error posting review reply:', err.message);
    res.status(500).json({ error: 'Server error updating review reply' });
  }
});

module.exports = router;
        
