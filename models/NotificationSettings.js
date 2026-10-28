const mongoose = require('mongoose');

const notificationSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  supportEmail: { type: String, default: '' },
  supportPhone: { type: String, default: '' },
  weeklyReport: {
    email: { type: Boolean, default: true }
  },
  criticalAlerts: {
    email: { type: Boolean, default: true }
  },
  productUpdates: {
    email: { type: Boolean, default: true }
  }
}, { timestamps: true });

module.exports = mongoose.model('NotificationSettings', notificationSettingsSchema);
