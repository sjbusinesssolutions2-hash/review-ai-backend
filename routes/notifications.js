const express = require('express');
const router = express.Router();
const NotificationSettings = require('../models/NotificationSettings');

// GET: Fetch notification settings
router.get('/settings', async (req, res) => {
  const userId = req.query.userId || req.headers.authorization;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let settings = await NotificationSettings.findOne({ userId });
    if (!settings) {
      settings = new NotificationSettings({ userId });
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    console.error('Error fetching notification settings:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST: Save notification settings
router.post('/settings', async (req, res) => {
  const userId = req.body.userId || req.headers.authorization;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates } = req.body;

    const updatedSettings = await NotificationSettings.findOneAndUpdate(
      { userId },
      { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates },
      { new: true, upsert: true }
    );

    res.json({ success: true, settings: updatedSettings });
  } catch (err) {
    console.error('Error saving notification settings:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
