/**
 * SJbs.AI - Production Engine
 * Multi-Location GBP Sync & Pure Dynamic Concurrent AQ. Gemini AI Engine
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors({
  origin: ['https://sjbusinesssolutions2-hash.github.io', 'http://localhost:3000'],
  credentials: true
}));

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Atlas Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

app.use(session({
  secret: process.env.SESSION_SECRET || 'sjbs_ai_production_secret',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Parse multiple AQ. keys from environment variable
const rawKeysInput = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const geminiKeys = rawKeysInput
  .split(',')
  .map(k => k.trim())
  .filter(k => k.startsWith('AQ.'));

const userSchema = new mongoose.Schema({
  googleId: String,
  displayName: String,
  email: String,
  avatar: String,
  accessToken: String,
  refreshToken: String,
  usedFreeDraftReviewIds: { type: [String], default: [] },
  freeRepliesUsed: { type: Number, default: 0 },
  savedDrafts: [{
    reviewId: String,
    draftText: String
  }],
  locations: [{
    locationId: String,
    accountLocationPath: String,
    locationName: String,
    rating: { type: Number, default: 5.0 },
    reviewCount: { type: Number, default: 0 },
    address: { type: String, default: '' },
    subscriptionStatus: { type: String, default: 'free' },
    autoReplyEnabled: { type: Boolean, default: true }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

function extractPersonalName(profile) {
  if (profile._json && profile._json.given_name) {
    const family = profile._json.family_name ? ` ${profile._json.family_name}` : '';
    return `${profile._json.given_name}${family}`;
  }
  return profile.displayName || 'User Account';
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://review-ai-backend-03sb.onrender.com/auth/google/callback',
    proxy: true
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      const personalName = extractPersonalName(profile);
      const emailVal = (profile.emails && profile.emails[0]) ? profile.emails[0].value : '';

      if (!user) {
        user = new User({
          googleId: profile.id,
          displayName: personalName,
          email: emailVal,
          avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : '',
          accessToken,
          refreshToken
        });
      } else {
        user.accessToken = accessToken;
        user.displayName = personalName;
        if (refreshToken) user.refreshToken = refreshToken;
      }
      await user.save();
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// Sequential Key & Model Failover Engine for Review Replies
async function generate2LineAIReply(businessName, reviewerName, starRating, comment) {
  if (!geminiKeys || geminiKeys.length === 0) {
    console.error('[Gemini AI] No valid AQ. API keys found in environment variables.');
    return null;
  }

  const cleanComment = (comment && comment.trim() !== '') ? comment.trim() : 'Great service!';
  const cleanName = (reviewerName && reviewerName.trim() !== '') ? reviewerName.trim().split(' ')[0] : 'customer';

  const prompt = `You are replying to a Google Business review for "${businessName}" as a business owner.

Reviewer: ${cleanName}
Rating: ${starRating} Stars
Review: "${cleanComment}"

Instructions:
1. Match the exact language and script of the customer's comment (English, Roman Hindi, Roman Gujarati, etc.).
2. Write a concise, natural response (1 to 2 sentences max).
3. Do NOT follow a fixed formula or template. Speak like a genuine person writing a unique message on the spot, referencing specific details from their review.
4. Avoid repetitive sign-offs, quotes, or preambles.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          let cleanText = responseText.trim().replace(/^["']|["']$/g, '');
          const sentences = cleanText.match(/[^.!?]+[.!?]+/g);
          
          if (sentences && sentences.length >= 2) {
            return `${sentences[0].trim()} ${sentences[1].trim()}`;
          } else if (sentences && sentences.length === 1) {
            return `${sentences[0].trim()}`;
          }
          return cleanText;
        }
      } catch (err) {
        console.warn(`[Gemini AI] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  console.error('[Gemini AI] All keys and model fallbacks exhausted.');
  return null;
}

// Dedicated Generator for Auto-Posts & Test Bench
async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    console.error('[Gemini AI] No valid AQ. API keys found in environment variables.');
    return null;
  }

  const prompt = `You are an expert social media manager for a local business named "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
Generate an engaging Google Business Profile post based on these settings:
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Festival/Holiday Greetings: ${enableFestivals ? 'Enabled (incorporate upcoming or seasonal theme if relevant)' : 'Disabled'}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled (highlight customer satisfaction)' : 'Disabled'}

Requirements:
1. 2 to 4 sentences long.
2. Professional, engaging, and inviting tone.
3. Include 1 clear call-to-action and 2 relevant hashtags.
4. Avoid repetitive formulas or rigid templates.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        console.warn(`[Gemini AI] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  console.error('[Gemini AI] All keys and model fallbacks exhausted for auto-post.');
  return 'Visit us today for great service and special offers! #LocalBusiness #CustomerFirst';
}

const AutoPostConfig = require('./models/AutoPostConfig');

// 1. Get Auto-Post Configuration for a Business
app.get('/api/auto-posts/config/:businessId', async (req, res) => {
  try {
    let config = await AutoPostConfig.findOne({ businessId: req.params.businessId });
    if (!config) {
      config = await AutoPostConfig.create({ businessId: req.params.businessId });
    }
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Update Auto-Post Preferences
app.post('/api/auto-posts/config/:businessId', async (req, res) => {
  try {
    const { enabled, frequency, preferredTime, topics, enableFestivals, enableReviewSpotlights } = req.body;

    const config = await AutoPostConfig.findOneAndUpdate(
      { businessId: req.params.businessId },
      { enabled, frequency, preferredTime, topics, enableFestivals, enableReviewSpotlights },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: 'Settings saved successfully', config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Get Scheduled & Post History
app.get('/api/auto-posts/history/:businessId', async (req, res) => {
  try {
    const posts = await Post.find({ businessId: req.params.businessId })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function fetchLocationReviews(accessToken, accountName, locationName) {
  try {
    let parentPath = locationName;
    if (!locationName.startsWith('accounts/')) {
      parentPath = `${accountName}/${locationName}`;
    }

    const res = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const reviews = data.reviews || [];
      const count = data.totalReviewCount || reviews.length;
      let rating = data.averageRating || 5.0;

      if (reviews.length > 0 && !data.averageRating) {
        const totalStars = reviews.reduce((acc, r) => {
          const val = r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1;
          return acc + val;
        }, 0);
        rating = totalStars / reviews.length;
      }

      return {
        reviews,
        reviewCount: count,
        rating: parseFloat(rating.toFixed(1)),
        parentPath
      };
    }
  } catch (err) {
    console.warn(`Fetch reviews notice for ${locationName}:`, err.message);
  }
  return { reviews: [], reviewCount: 0, rating: 5.0, parentPath: locationName };
}

// 24/7 Automated Background Auto-Reply Worker for Pro Businesses
cron.schedule('*/15 * * * *', async () => {
  console.log('[Auto-Reply Worker] Running periodic check for unanswered reviews across Pro locations...');
  try {
    const users = await User.find({ 'locations.subscriptionStatus': 'pro', 'locations.autoReplyEnabled': true });

    for (const user of users) {
      if (!user.accessToken) continue;

      for (const loc of user.locations) {
        if (loc.subscriptionStatus !== 'pro' || !loc.autoReplyEnabled) continue;

        const parentPath = loc.accountLocationPath || loc.locationId;
        const reviewData = await fetchLocationReviews(user.accessToken, parentPath.split('/')[0] + '/' + parentPath.split('/')[1], parentPath);
        const unreplied = (reviewData.reviews || []).filter(r => !r.reviewReply);

        for (const review of unreplied) {
          const reviewerName = review.reviewer && review.reviewer.displayName ? review.reviewer.displayName : 'Customer';
          const starVal = review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 : review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1;
          
          const replyText = await generate2LineAIReply(loc.locationName, reviewerName, starVal, review.comment || '');

          if (replyText) {
            const googleRes = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews/${review.reviewId}/reply`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ comment: replyText })
            });

            if (googleRes.ok) {
              console.log(`[Auto-Reply Worker] Successfully replied automatically for location: ${loc.locationName}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Reply Worker] Error executing background worker:', err.message);
  }
});

app.get('/auth/google', passport.authenticate('google', {
  scope: [
    'profile',
    'email',
    'https://www.googleapis.com/auth/business.manage'
  ],
  accessType: 'offline',
  prompt: 'consent'
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: 'https://sjbusinesssolutions2-hash.github.io/login.html' }),
  async (req, res) => {
    try {
      const user = req.user;
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: user.accessToken });

      const mybusinessaccountmanagement = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
      const accountsRes = await mybusinessaccountmanagement.accounts.list();
      const accounts = accountsRes.data.accounts || [];

      let fetchedLocations = [];
      const existingLocations = user.locations || [];

      for (const acc of accounts) {
        try {
          const mybusinessinfo = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
          const locsRes = await mybusinessinfo.accounts.locations.list({
            parent: acc.name,
            readMask: 'name,title,storefrontAddress'
          });

          if (locsRes.data.locations) {
            for (const [idx, loc] of locsRes.data.locations.entries()) {
              const reviewData = await fetchLocationReviews(user.accessToken, acc.name, loc.name);

              // Preserve database subscription state across logins
              const existingLoc = existingLocations.find(l => l.locationId === loc.name);
              const defaultStatus = idx === 0 ? 'pro' : 'free';
              const finalStatus = existingLoc ? existingLoc.subscriptionStatus : defaultStatus;

              fetchedLocations.push({
                locationId: loc.name,
                accountLocationPath: reviewData.parentPath,
                locationName: loc.title,
                rating: reviewData.rating,
                reviewCount: reviewData.reviewCount,
                address: loc.storefrontAddress && loc.storefrontAddress.addressLines ? loc.storefrontAddress.addressLines.join(', ') : '',
                subscriptionStatus: finalStatus,
                autoReplyEnabled: existingLoc ? existingLoc.autoReplyEnabled : true
              });
            }
          }
        } catch (e) {
          console.warn('Location listing notice:', e.message);
        }
      }

      user.locations = fetchedLocations;
      await user.save();

      const userName = encodeURIComponent(user.displayName || 'User');
      const userEmail = encodeURIComponent(user.email || '');

      res.redirect(`https://sjbusinesssolutions2-hash.github.io/inbox.html?userId=${user._id}&userName=${userName}&userEmail=${userEmail}`);
    } catch (err) {
      console.error('OAuth Callback Error:', err);
      res.redirect(`https://sjbusinesssolutions2-hash.github.io/inbox.html?userId=${req.user._id}&userName=${encodeURIComponent(req.user.displayName || 'User')}`);
    }
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
      });
    } else {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    }
  });
});

app.get('/api/user', async (req, res) => {
  const userId = req.query.userId || req.headers.authorization;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/businesses', async (req, res) => {
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

app.get('/api/reviews/all', async (req, res) => {
  const { userId, businessId } = req.query;

  if (!userId || !businessId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    console.log(`[API /reviews/all] Fetching reviews for User: ${userId}, Business: ${businessId}`);
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'User or access token not found' });
    }

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const targetBusinessName = targetLocation ? targetLocation.locationName : 'Our Business';
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;
    const isPro = targetLocation && targetLocation.subscriptionStatus === 'pro';

    let rawReviews = [];

    try {
      const response = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews`, {
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
      } else {
        console.warn(`[API /reviews/all] Google API returned status: ${response.status}`);
      }
    } catch (err) {
      console.warn('[API /reviews/all] Reviews Google API fetch error:', err.message);
    }

    let userModified = false;
    let freeRepliesCount = user.freeRepliesUsed || 0;

    console.log(`[API /reviews/all] Total reviews fetched: ${rawReviews.length}. Processing unreplied items...`);

    const processedReviews = await Promise.all(
      rawReviews.map(async (item) => {
        let aiDraftReply = '';

        if (!item.reply) {
          let existingDraft = user.savedDrafts.find(d => d.reviewId === item.reviewId);

          if (existingDraft && existingDraft.draftText) {
            aiDraftReply = existingDraft.draftText;
            console.log(`[API /reviews/all] Loaded cached MongoDB draft for reviewId: ${item.reviewId}`);
          } else {
            let canGenerate = true;
            if (!isPro) {
              if (freeRepliesCount >= 2) {
                canGenerate = false;
              }
            }

            if (canGenerate) {
              const generated = await generate2LineAIReply(
                targetBusinessName,
                item.reviewerName,
                item.starRating,
                item.comment
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
      console.log(`[API /reviews/all] Saved new drafts to MongoDB for user: ${userId}`);
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

app.post('/api/reviews/dismiss', async (req, res) => {
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

app.post('/api/reviews/reply', async (req, res) => {
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

    const googleRes = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews/${reviewId}/reply`, {
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
      console.warn('Google Business Reply API Error:', errorText);
      return res.status(googleRes.status).json({ error: 'Failed to post reply to Google Business Profile' });
    }
  } catch (err) {
    console.error('Error posting review reply:', err.message);
    res.status(500).json({ error: 'Server error updating review reply' });
  }
});

// Admin Panel APIs
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-accessToken -refreshToken');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users list' });
  }
});

app.post('/api/admin/update-subscription', async (req, res) => {
  let { userId, locationId, subscriptionStatus } = req.body;

  if (!userId || !locationId || !subscriptionStatus) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const rawLocId = decodeURIComponent(locationId);

    // Atomic update directly targeting the matched subdocument in the locations array
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

app.post('/api/admin/reset-free-limit', async (req, res) => {
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

// Test Generate Route with Gemini Text & Open AI Image Generation
app.post('/api/auto-posts/test-generate', async (req, res) => {
  try {
    const { locationName, category, topics, enableFestivals, enableReviewSpotlights } = req.body;

    const bName = locationName || 'Our Business';
    const bCat = category || 'Local Business';

    // 1. Generate post text using your existing function
    const postText = await generateAutoPostText(bName, bCat, topics, enableFestivals, enableReviewSpotlights);

    // 2. Prompt for SVG code generation using your existing generateAutoPostText helper
    const svgPrompt = `Create a sleek, modern commercial vector banner graphic in raw SVG XML format for:
- Business: ${bName}
- Category: ${bCat}
- Focus Topics: ${topics || bCat}

Design Guidelines:
- ViewBox="0 0 800 600"
- Use attractive background gradients, simple vector illustrations, or decorative icons relevant to ${bCat}.
- Make sure "${bName}" is written clearly as prominent bold text.
- Output ONLY valid raw <svg>...</svg> XML code. No markdown code blocks, no intro or outro text.`;

    // Use your existing text generation helper
    const rawSvgText = await generateAutoPostText(bName, bCat, svgPrompt, false, false);

    // Clean up response if the model outputs markdown code blocks
    let cleanSvg = rawSvgText
      .replace(/```xml/gi, '')
      .replace(/```svg/gi, '')
      .replace(/```/g, '')
      .trim();

    // Extract SVG content if there's any surrounding text
    const svgMatch = cleanSvg.match(/<svg[\s\S]*?<\/svg>/i);
    if (svgMatch) {
      cleanSvg = svgMatch[0];
    } else {
      // Safe fallback SVG layout
      cleanSvg = `<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" viewBox="0 0 800 600" width="100%" height="100%">
        <rect width="800" height="600" fill="#0f172a"/>
        <text x="400" y="280" font-family="sans-serif" font-size="36" fill="#ffffff" font-weight="bold" text-anchor="middle">${bName}</text>
        <text x="400" y="340" font-family="sans-serif" font-size="20" fill="#a5b4fc" text-anchor="middle">${bCat}</text>
      </svg>`;
    }

    // Base64 encode to safely transmit to frontend
    const base64Svg = Buffer.from(cleanSvg).toString('base64');
    const imageUrl = `data:image/svg+xml;base64,${base64Svg}`;

    res.json({
      success: true,
      postText: postText || 'Visit us today for great service and special offers! #LocalBusiness',
      imageUrl: imageUrl,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in test-generate route:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auto-posts/process-scheduled', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET_KEY}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized cron trigger' });
    }

    console.log('[Cron Job] Processing scheduled posts for active B2B Pro users...');

    // Fetch active businesses from MongoDB
    const activeBusinesses = await Business.find({ 'autoPostConfig.enabled': true });
    let processedCount = 0;

    for (const biz of activeBusinesses) {
      if (isPostDue(biz.lastPostedAt, biz.autoPostConfig?.frequency || 'daily')) {
        
        // 1. Generate text
        const postText = await generateAutoPostText(
          biz.name, 
          biz.category, 
          biz.topics, 
          biz.autoPostConfig?.enableFestivals, 
          biz.autoPostConfig?.enableReviewSpotlights
        );

        // 2. Generate unique SVG vector banner via text model
        const svgPrompt = `Create a sleek commercial vector banner in raw SVG format for:
- Business: ${biz.name}
- Category: ${biz.category}
- Focus: ${biz.topics || biz.category}

ViewBox="0 0 800 600". Output ONLY pure raw <svg>...</svg> XML code.`;

        const rawSvgText = await generateAutoPostText(biz.name, biz.category, svgPrompt, false, false);
        
        let cleanSvg = rawSvgText.replace(/```xml/gi, '').replace(/```svg/gi, '').replace(/```/g, '').trim();
        const svgMatch = cleanSvg.match(/<svg[\s\S]*?<\/svg>/i);
        cleanSvg = svgMatch ? svgMatch[0] : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="#0f172a"/><text x="400" y="300" fill="#fff" font-size="36" text-anchor="middle">${biz.name}</text></svg>`;

        const base64Svg = Buffer.from(cleanSvg).toString('base64');
        const imageUrl = `data:image/svg+xml;base64,${base64Svg}`;

        // 3. Save / Publish post
        await Post.create({
          businessId: biz._id,
          postText: postText,
          imageUrl: imageUrl,
          status: 'PUBLISHED',
          createdAt: new Date()
        });

        biz.lastPostedAt = new Date();
        await biz.save();
        processedCount++;
      }
    }

    res.json({ success: true, processed: processedCount });
  } catch (err) {
    console.error('Error in scheduled post processing:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function isPostDue(lastPostedAt, frequency) {
  if (!lastPostedAt) return true;
  const now = new Date();
  const diffInHours = (now - new Date(lastPostedAt)) / (1000 * 60 * 60);
  if (frequency === 'daily') return diffInHours >= 20;
  if (frequency === 'weekly') return diffInHours >= 160;
  return false;
}

app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
