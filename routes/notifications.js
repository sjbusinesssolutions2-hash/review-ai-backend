const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const NotificationSettings = require('../models/NotificationSettings');

// GET: Fetch notification settings
router.get('/settings', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized - Missing userId' });

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    let settings = await NotificationSettings.findOne({ userId: objectId });
    if (!settings) {
      settings = new NotificationSettings({ userId: objectId });
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
    const objectId = new mongoose.Types.ObjectId(userId);
    const { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates } = req.body;

    const updatedSettings = await NotificationSettings.findOneAndUpdate(
      { userId: objectId },
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
