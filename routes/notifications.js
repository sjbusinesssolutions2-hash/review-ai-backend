const express = require('express');
const router = express.Router();
const NotificationSettings = require('../models/NotificationSettings');
const authMiddleware = require('../middleware/auth'); // Matches your existing token auth

// GET: Fetch notification settings for logged-in user
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    let settings = await NotificationSettings.findOne({ userId: req.user._id });
    if (!settings) {
      // Create default settings document if none exists yet
      settings = new NotificationSettings({ userId: req.user._id });
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    console.error('Error fetching notification settings:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST: Save/Upsert notification settings
router.post('/settings', authMiddleware, async (req, res) => {
  try {
    const { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates } = req.body;

    const updatedSettings = await NotificationSettings.findOneAndUpdate(
      { userId: req.user._id },
      { 
        supportEmail, 
        supportPhone, 
        weeklyReport, 
        criticalAlerts, 
        productUpdates 
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, settings: updatedSettings });
  } catch (err) {
    console.error('Error saving notification settings:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/api/notifications', router); // Register route in your main server.js
