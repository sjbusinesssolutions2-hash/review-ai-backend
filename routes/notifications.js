const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const NotificationSettings = require('../models/NotificationSettings');

// Helper to get userId from Authorization header
const getUserIdFromReq = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  return decoded.userId || decoded.id; // Adjust based on your login token structure
};

// GET: Fetch notification settings
router.get('/settings', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let settings = await NotificationSettings.findOne({ userId });
    if (!settings) {
      settings = new NotificationSettings({ userId });
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Save notification settings
router.post('/settings', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates } = req.body;

    const updatedSettings = await NotificationSettings.findOneAndUpdate(
      { userId },
      { supportEmail, supportPhone, weeklyReport, criticalAlerts, productUpdates },
      { new: true, upsert: true }
    );

    res.json({ success: true, settings: updatedSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
