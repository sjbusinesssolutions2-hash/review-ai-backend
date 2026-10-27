const mongoose = require('mongoose');

const autoPostConfigSchema = new mongoose.Schema({
  businessId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  enabled: { type: Boolean, default: false },
  frequency: { type: String, enum: ['daily', 'weekly', 'biweekly'], default: 'weekly' },
  preferredTime: { type: String, default: '10:00' }, // HH:mm format
  topics: { type: String, default: '' },
  enableFestivals: { type: Boolean, default: true },
  enableReviewSpotlights: { type: Boolean, default: true },
  lastPostedAt: { type: Date, default: null },
  history: [{
    postText: String,
    imageUrl: String,
    publishedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['LIVE', 'FAILED'], default: 'LIVE' },
    googlePostId: String,
    errorDetails: String
  }]
}, { timestamps: true });

module.exports = mongoose.model('AutoPostConfig', autoPostConfigSchema);
