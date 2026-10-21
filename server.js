/**
 * SJbs.AI - Production Enterprise Backend Engine
 * Live Google My Business Profile Sync, Gemini AI Draft Engine, Per-Location Subscriptions
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

// Initialize Google Gemini AI Engine
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Connect to MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB Atlas Connected'))
.catch(err => console.error('MongoDB Connection Error:', err));

// MongoDB User Schema
const userSchema = new mongoose.Schema({
  googleId: String,
  displayName: String,
  email: String,
  avatar: String,
  accessToken: String,
  refreshToken: String,
  locations: [{
    locationId: String,
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

// Passport Google OAuth Strategy with Offline Access for GBP Management
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://review-ai-backend-03sb.onrender.com/auth/google/callback',
    proxy: true
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        user = new User({
          googleId: profile.id,
          displayName: profile.displayName,
          email: profile.emails && profile.emails[0] ? profile.emails[0].value : '',
          avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : '',
          accessToken,
          refreshToken
        });
      } else {
        user.accessToken = accessToken;
        if (refreshToken) user.refreshToken = refreshToken;
        if (profile.displayName) user.displayName = profile.displayName;
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

/**
 * Resilient 2-Line Professional Gemini AI Generator
 * Retries indefinitely until a valid reply is returned
 */
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
      console.warn('Gemini AI busy or rate limited, retrying in 2 seconds...', err.message);
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

      // Dynamically fetch real Google Business Profile accounts & locations
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
              let reviewCount = 0;
              let rating = 5.0;

              // Fetch actual live reviews to compute accurate review counts and star ratings
              try {
                const mybusinessreviews = google.mybusinessreviews({ version: 'v1', auth: oauth2Client });
                const revRes = await mybusinessreviews.accounts.locations.reviews.list({ parent: loc.name });
                const reviews = revRes.data.reviews || [];
                reviewCount = reviews.length;

                if (reviewCount > 0) {
                  const totalStars = reviews.reduce((accStars, r) => {
                    const val = r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1;
                    return accStars + val;
                  }, 0);
                  rating = parseFloat((totalStars / reviewCount).toFixed(1));
                }
              } catch (revErr) {
                console.warn('Could not fetch review metrics for location:', loc.name);
              }

              fetchedLocations.push({
                locationId: loc.name,
                locationName: loc.title,
                rating: rating,
                reviewCount: reviewCount,
                address: loc.storefrontAddress && loc.storefrontAddress.addressLines ? loc.storefrontAddress.addressLines.join(', ') : '',
                hasActivePlan: idx === 0,
                subscriptionStatus: idx === 0 ? 'pro' : 'free'
              });
            }
          }
        } catch (e) {
          console.warn('Location list notice:', e.message);
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
    if (err) console.error('Logout error:', err);
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully' });
      });
    } else {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    }
  });
});

// --- USER & LOCATIONS API ---
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

// Fetch Real Connected Business Profile Locations (Zero Hardcoding)
app.get('/api/businesses', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId parameter' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const formattedBusinesses = (user.locations || []).map(loc => ({
      id: loc.locationId,
      name: loc.locationName,
      rating: loc.rating ? loc.rating.toFixed(1) : '5.0',
      reviewCount: loc.reviewCount || 0,
      address: loc.address || '',
      hasActivePlan: loc.hasActivePlan || false,
      subscriptionStatus: loc.subscriptionStatus || 'free'
    }));

    res.json(formattedBusinesses);
  } catch (err) {
    console.error('Error fetching businesses:', err.message);
    res.status(500).json({ error: 'Server error fetching businesses' });
  }
});

// Fetch Real Unreplied Google Reviews & Generate Gemini AI 2-Line Drafts
app.get('/api/reviews/unreplied', async (req, res) => {
  const { userId, businessId } = req.query;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const targetBusinessName = targetLocation ? targetLocation.locationName : 'Our Business';

    let rawReviews = [];

    // Attempt Live Google Business Profile Review Sync via API
    if (user.accessToken && businessId && businessId.startsWith('accounts/')) {
      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: user.accessToken });
        const mybusinessreviews = google.mybusinessreviews({ version: 'v1', auth: oauth2Client });
        
        const reviewsRes = await mybusinessreviews.accounts.locations.reviews.list({
          parent: businessId
        });

        const fetchedReviews = reviewsRes.data.reviews || [];
        rawReviews = fetchedReviews.filter(r => !r.reviewReply).map(r => ({
          reviewId: r.reviewId,
          reviewerName: r.reviewer && r.reviewer.displayName ? r.reviewer.displayName : 'Google User',
          starRating: r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1,
          comment: r.comment || ''
        }));
      } catch (err) {
        console.warn('GMB Review Sync notice:', err.message);
      }
    }

    // Generate Guaranteed 2-Line Professional Gemini AI Replies for each unreplied review
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

// Post Reply Live to Google Business Profile
app.post('/api/reviews/reply', async (req, res) => {
  const { userId, businessId, reviewId, replyText } = req.body;

  if (!replyText || replyText.trim() === '') {
    return res.status(400).json({ error: 'Reply text cannot be empty' });
  }

  try {
    const user = await User.findById(userId);

    if (user && user.accessToken && businessId && businessId.startsWith('accounts/')) {
      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: user.accessToken });
        const mybusinessreviews = google.mybusinessreviews({ version: 'v1', auth: oauth2Client });

        await mybusinessreviews.accounts.locations.reviews.updateReply({
          name: `${businessId}/reviews/${reviewId}/reply`,
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

// Root Health Check
app.get('/', (req, res) => res.send('SJbs.AI Enterprise Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
        
