/**
 * SJbs.AI - Production Enterprise Backend Engine
 * Supports Owner and Manager Account Permissions for Google Business Profiles
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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB Atlas Connected'))
.catch(err => console.error('MongoDB Connection Error:', err));

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

// Extract Personal User Identity strictly from OAuth Profile
function extractPersonalName(profile) {
  const email = (profile.emails && profile.emails[0]) ? profile.emails[0].value : '';
  
  // Check if given/family name exist directly in profile JSON
  if (profile._json && profile._json.given_name) {
    const family = profile._json.family_name ? ` ${profile._json.family_name}` : '';
    return `${profile._json.given_name}${family}`;
  }

  // Fall back to clean email prefix
  if (email) {
    const prefix = email.split('@')[0];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }

  return 'User';
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

// Helper: Query Google My Business Reviews API (Handles both Owner and Manager roles)
async function fetchGoogleLocationMetrics(accessToken, locationResourceName) {
  try {
    const mybusinessreviews = google.mybusinessreviews({
      version: 'v1',
      auth: new google.auth.OAuth2().setCredentials({ access_token: accessToken })
    });

    const res = await fetch(`https://mybusiness.googleapis.com/v4/${locationResourceName}/reviews`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const count = data.totalReviewCount || (data.reviews ? data.reviews.length : 0);
      const rating = data.averageRating || 5.0;
      return { reviewCount: count, rating: parseFloat(rating.toFixed(1)) };
    }
  } catch (e) {
    console.warn(`Metrics fetch note for ${locationResourceName}:`, e.message);
  }
  return { reviewCount: 0, rating: 5.0 };
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
              const metrics = await fetchGoogleLocationMetrics(user.accessToken, loc.name);

              fetchedLocations.push({
                locationId: loc.name,
                locationName: loc.title,
                rating: metrics.rating,
                reviewCount: metrics.reviewCount,
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
    if (err) console.error('Logout error:', err);
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

// Fetch Business Profiles with Manager-Level Live Review Aggregation
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

      if (user.accessToken && loc.locationId) {
        const liveMetrics = await fetchGoogleLocationMetrics(user.accessToken, loc.locationId);
        if (liveMetrics.reviewCount > 0) {
          liveCount = liveMetrics.reviewCount;
          liveRating = liveMetrics.rating;
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

app.get('/', (req, res) => res.send('SJbs.AI Enterprise Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
