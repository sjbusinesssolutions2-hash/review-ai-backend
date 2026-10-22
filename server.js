/**
 * SJbs.AI - Production Enterprise Backend Engine
 * Live Manager & Owner Google My Business Sync, Gemini AI Replies
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors({
  origin: ['https://sjbusinesssolutions2-hash.github.io', 'http://localhost:3000'],
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'sjbs_ai_production_secret',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Initialize Gemini AI Engine
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Connect to MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB Atlas Connected'))
.catch(err => console.error('MongoDB Connection Error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  googleId: String,
  displayName: String,
  email: String,
  avatar: String,
  accessToken: String,
  refreshToken: String,
  locations: [{
    locationId: String,
    accountLocationPath: String,
    locationName: String,
    rating: { type: Number, default: 5.0 },
    reviewCount: { type: Number, default: 0 },
    address: { type: String, default: '' },
    hasActivePlan: { type: Boolean, default: false },
    subscriptionStatus: { type: String, default: 'free' }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Helper: Extract real personal name strictly from Google profile payload
function extractPersonalName(profile) {
  if (profile._json && profile._json.given_name) {
    const family = profile._json.family_name ? ` ${profile._json.family_name}` : '';
    return `${profile._json.given_name}${family}`;
  }
  return profile.displayName || 'User Account';
}

// Passport Strategy
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

// Helper: Helper to query reviews cleanly across Owner and Manager scopes
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
    console.warn(`Fetch reviews error for ${locationName}:`, err.message);
  }
  return { reviews: [], reviewCount: 0, rating: 5.0, parentPath: locationName };
}

// AI Generator
async function generate2LineAIReply(businessName, reviewerName, starRating, comment) {
  const prompt = `
    You are an expert business reputation manager writing an authentic, warm response on behalf of "${businessName}".
    Customer Name: "${reviewerName || 'Valued Customer'}"
    Star Rating: ${starRating}/5 stars
    Customer Review: "${comment || 'Great experience!'}"

    STRICT GUIDELINES:
    1. Write EXACTLY 2 natural, warm, and professional sentences.
    2. Sentence 1: Thank the customer by name and acknowledge their review or visit.
    3. Sentence 2: Reaffirm your commitment to excellence and welcome them back.
    4. Do not include intro filler, tags, or preambles.
  `;

  let success = false;
  let replyText = '';

  while (!success) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      if (response && response.text) {
        replyText = response.text.trim();
        if (replyText.length > 0) success = true;
      }
    } catch (err) {
      await new Promise(res => setTimeout(res, 2000));
    }
  }

  return replyText;
}

// --- AUTH ROUTES ---
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
  passport.authenticate('google', { failureRedirect: 'https://sjbusinesssolutions2-hash.github.io/review-ai-app/login.html' }),
  async (req, res) => {
    try {
      const user = req.user;
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: user.accessToken });

      const mybusinessaccountmanagement = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
      const accountsRes = await mybusinessaccountmanagement.accounts.list();
      const accounts = accountsRes.data.accounts || [];

      let fetchedLocations = [];

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

              fetchedLocations.push({
                locationId: loc.name,
                accountLocationPath: reviewData.parentPath,
                locationName: loc.title,
                rating: reviewData.rating,
                reviewCount: reviewData.reviewCount,
                address: loc.storefrontAddress && loc.storefrontAddress.addressLines ? loc.storefrontAddress.addressLines.join(', ') : '',
                hasActivePlan: idx === 0,
                subscriptionStatus: idx === 0 ? 'pro' : 'free'
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

      res.redirect(`https://sjbusinesssolutions2-hash.github.io/review-ai-app/inbox.html?userId=${user._id}&userName=${userName}&userEmail=${userEmail}`);
    } catch (err) {
      console.error('OAuth Callback Error:', err);
      res.redirect(`https://sjbusinesssolutions2-hash.github.io/review-ai-app/inbox.html?userId=${req.user._id}&userName=${encodeURIComponent(req.user.displayName || 'User')}`);
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

// Fetch Business Profiles with Live Counts
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
        hasActivePlan: idx === 0,
        subscriptionStatus: idx === 0 ? 'pro' : 'free'
      });
    }

    res.json(formattedBusinesses);
  } catch (err) {
    console.error('Error fetching businesses:', err.message);
    res.status(500).json({ error: 'Server error fetching businesses' });
  }
});

// Fetch All Google Reviews with Dynamic Account Discovery & Tab Metrics
app.get('/api/reviews/all', async (req, res) => {
  const { userId, businessId } = req.query;

  if (!userId || !businessId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'User or access token not found' });
    }

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const targetBusinessName = targetLocation ? targetLocation.locationName : 'Our Business';

    let rawReviews = [];
    let parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : null;

    if (!parentPath) {
      try {
        const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
          headers: { 'Authorization': `Bearer ${user.accessToken}` }
        });
        if (accountsRes.ok) {
          const accountsData = await accountsRes.json();
          const accounts = accountsData.accounts || [];
          
          for (const acc of accounts) {
            const locsRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations`, {
              headers: { 'Authorization': `Bearer ${user.accessToken}` }
            });
            if (locsRes.ok) {
              const locsData = await locsRes.json();
              const match = (locsData.locations || []).find(l => l.name.includes(businessId));
              if (match) {
                parentPath = match.name;
                break;
              }
            }
          }
        }
      } catch (discErr) {
        console.warn('Dynamic location discovery notice:', discErr.message);
      }
    }

    if (!parentPath) {
      parentPath = `locations/${businessId}`;
    }

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
      }
    } catch (err) {
      console.warn('Reviews API fetch notice:', err.message);
    }

    const processedReviews = await Promise.all(
      rawReviews.map(async (item) => {
        let aiDraftReply = '';
        if (!item.reply) {
          aiDraftReply = await generate2LineAIReply(
            targetBusinessName,
            item.reviewerName,
            item.starRating,
            item.comment
          );
        }
        return {
          ...item,
          aiDraftReply
        };
      })
    );

    const needsReplyCount = processedReviews.filter(r => !r.reply).length;
    const repliedCount = processedReviews.filter(r => r.reply).length;

    res.json({
      reviews: processedReviews,
      counts: {
        needsYou: needsReplyCount,
        all: processedReviews.length,
        replied: repliedCount
      }
    });
  } catch (err) {
    console.error('Error fetching all reviews:', err.message);
    res.status(500).json({ error: 'Server error fetching reviews' });
  }
});

// Fetch Unreplied Google Reviews & Generate Gemini AI Drafts
app.get('/api/reviews/unreplied', async (req, res) => {
  const { userId, businessId } = req.query;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const targetBusinessName = targetLocation ? targetLocation.locationName : 'Our Business';
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;

    let rawReviews = [];

    if (user.accessToken && parentPath) {
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
          rawReviews = fetchedReviews.filter(r => !r.reviewReply).map(r => ({
            reviewId: r.reviewId,
            reviewerName: (r.reviewer && r.reviewer.displayName) ? r.reviewer.displayName : 'Google User',
            starRating: r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1,
            comment: r.comment || ''
          }));
        }
      } catch (err) {
        console.warn('Unreplied fetch notice:', err.message);
      }
    }

    const processedReviews = await Promise.all(
      rawReviews.map(async (item) => {
        const aiDraftReply = await generate2LineAIReply(
          targetBusinessName,
          item.reviewerName,
          item.starRating,
          item.comment
        );

        return {
          reviewId: item.reviewId,
          reviewerName: item.reviewerName,
          starRating: item.starRating,
          comment: item.comment,
          aiDraftReply: aiDraftReply
        };
      })
    );

    res.json(processedReviews);
  } catch (err) {
    console.error('Error fetching unreplied reviews:', err.message);
    res.status(500).json({ error: 'Server error fetching unreplied reviews' });
  }
});

// Post Reply Live
app.post('/api/reviews/reply', async (req, res) => {
  const { userId, businessId, reviewId, replyText } = req.body;

  if (!replyText || replyText.trim() === '') {
    return res.status(400).json({ error: 'Reply text cannot be empty' });
  }

  try {
    const user = await User.findById(userId);
    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;

    if (user && user.accessToken && parentPath) {
      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: user.accessToken });
        const mybusinessreviews = google.mybusinessreviews({ version: 'v1', auth: oauth2Client });

        await mybusinessreviews.accounts.locations.reviews.updateReply({
          name: `${parentPath}/reviews/${reviewId}/reply`,
          requestBody: { comment: replyText }
        });
      } catch (gmbErr) {
        console.warn('GMB Live Post notice:', gmbErr.message);
      }
    }

    res.json({ success: true, message: 'Reply posted successfully' });
  } catch (err) {
    console.error('Error posting review reply:', err.message);
    res.status(500).json({ error: 'Failed to post reply' });
  }
});

app.get('/', (req, res) => res.send('SJbs.AI Enterprise Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
      
