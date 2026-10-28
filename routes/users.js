const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { fetchLocationReviews } = require('../services/gbpService');

// User details API
router.get(['/user', '/user/me'], async (req, res) => {
  const userId = req.query.userId || req.headers.authorization;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// User businesses API
router.get('/businesses', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const formattedBusinesses = [];

    for (const [idx, loc] of (user.locations || []).entries()) {
      let liveCount = loc.reviewCount || 0;
      let liveRating = loc.rating || 5.0;

      if (user.accessToken && loc.accountLocationPath) {
        const parts = loc.accountLocationPath.split('/');
        const accountName = parts.slice(0, 2).join('/');
        const locationName = parts.slice(2).join('/');
        const liveData = await fetchLocationReviews(user.accessToken, accountName, locationName);
        if (liveData.reviewCount > 0) {
          liveCount = liveData.reviewCount;
          liveRating = liveData.rating;
        }
      }

      formattedBusinesses.push({
        id: loc.locationId,
        name: loc.locationName,
        rating: liveRating.toFixed(1),
        reviewCount: liveCount,
        address: loc.address || '',
        subscriptionStatus: loc.subscriptionStatus || 'free'
      });
    }

    res.json(formattedBusinesses);
  } catch (err) {
    console.error('Error fetching businesses:', err.message);
    res.status(500).json({ error: 'Server error fetching businesses' });
  }
});

// Admin Panel APIs
router.get('/admin/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-accessToken -refreshToken');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users list' });
  }
});

router.post('/admin/update-subscription', async (req, res) => {
  let { userId, locationId, subscriptionStatus } = req.body;

  if (!userId || !locationId || !subscriptionStatus) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const rawLocId = decodeURIComponent(locationId);

    const result = await User.updateOne(
      { _id: userId, 'locations.locationId': rawLocId },
      { $set: { 'locations.$.subscriptionStatus': subscriptionStatus } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'User or Location not found' });
    }

    res.json({ success: true, message: `Updated location status to ${subscriptionStatus}` });
  } catch (err) {
    console.error('Update subscription error:', err);
    res.status(500).json({ success: false, error: 'Server error updating subscription' });
  }
});

router.post('/admin/reset-free-limit', async (req, res) => {
  const { userId } = req.body;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.freeRepliesUsed = 0;
    user.savedDrafts = [];
    await user.save();

    res.json({ success: true, message: 'Reset free usage counter' });
  } catch (err) {
    res.status(500).json({ error: 'Server error resetting limit' });
  }
});

module.exports = router;
              
