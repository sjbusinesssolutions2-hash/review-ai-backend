const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const NotificationSettings = require('../models/NotificationSettings');

// Helper to find settings by checking ObjectId or generic string (googleId)
const findQuery = (userId) => {
  if (mongoose.Types.ObjectId.isValid(userId) && userId.length === 24) {
    return { userId: new mongoose.Types.ObjectId(userId) };
  }
  return { userId: userId }; // Fallback for googleId or string IDs
};

// GET: Fetch notification settings
router.get('/settings', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized - Missing userId' });

  try {
    const query = findQuery(userId);
    let settings = await NotificationSettings.findOne(query);
    if (!settings) {
      settings = new NotificationSettings(query);
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    console.error('Error fetching notification settings:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Save notification settings
router.post('/settings', async (req, res) => {
  const userId = req.body.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized - Missing userId' });

  try {
    const query = findQuery(userId);
    const { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates } = req.body;

    const updatedSettings = await NotificationSettings.findOneAndUpdate(
      query,
      { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates },
      { new: true, upsert: true }
    );

    res.json({ success: true, settings: updatedSettings });
  } catch (err) {
    console.error('Error saving notification settings:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
