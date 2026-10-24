const mongoose = require('mongoose');

const autoPostConfigSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  enabled: { type: Boolean, default: false },
  frequency: { type: String, enum: ['daily', 'weekly'], default: 'daily' },
  preferredTime: { type: String, default: '10:00' },
  topics: { type: [String], default: [] },
  enableFestivals: { type: Boolean, default: true },
  enableReviewSpotlights: { type: Boolean, default: true },
  lastPostedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('AutoPostConfig', autoPostConfigSchema);
