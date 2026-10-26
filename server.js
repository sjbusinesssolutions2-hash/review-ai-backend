/**
 * SJbs.AI - Production GBP Automation Engine
 * High-End Professional Marketing Poster SVG Engine + Organic AI Post Writer
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
const axios = require('axios');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://sjbusinesssolutions2-hash.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
].filter(Boolean);

app.use(express.json());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.github.io')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
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
  savedDrafts: [{ reviewId: String, draftText: String }],
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
const AutoPostConfig = require('./models/AutoPostConfig');

function extractPersonalName(profile) {
  if (profile._json && profile._json.given_name) {
    const family = profile._json.family_name ? ` ${profile._json.family_name}` : '';
    return `${profile._json.given_name}${family}`;
  }
  return profile.displayName || 'User Account';
}

const backendHostUrl = process.env.BACKEND_URL || 'https://review-ai-backend-03sb.onrender.com';

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${backendHostUrl}/auth/google/callback`,
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

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/business.manage'],
  accessType: 'offline',
  prompt: 'consent'
}));

const frontendBaseUrl = process.env.FRONTEND_URL || 'https://sjbusinesssolutions2-hash.github.io/review-ai-app';

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: `${frontendBaseUrl}/login.html` }),
  async (req, res) => {
    try {
      const user = req.user;
      res.redirect(`${frontendBaseUrl}/inbox.html?userId=${user._id}&userName=${encodeURIComponent(user.displayName)}&userEmail=${encodeURIComponent(user.email)}`);
    } catch (err) {
      res.redirect(`${frontendBaseUrl}/inbox.html?userId=${req.user._id}`);
    }
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (req.session) req.session.destroy(() => res.json({ success: true }));
    else res.json({ success: true });
  });
});

async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we take pride in delivering exceptional ${category || 'services'} for our local community. Visit our workshop today! #${(locationName || 'Business').replace(/\s+/g, '')} #${(category || 'Service').replace(/\s+/g, '')}`;
  }

  const prompt = `You are an expert social media writer creating an authentic Google Business Profile post for "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).

Post Focus & Settings:
- Business Focus / Topics: ${topics || 'Highlighting our core expertise and craftsmanship'}
- Seasonal Greetings: ${enableFestivals ? 'ENABLED (Include warm festive wishes)' : 'DISABLED'}
- Review Spotlight: ${enableReviewSpotlights ? 'ENABLED (Reflect real customer trust and 5-star feedback)' : 'DISABLED'}

STRICT RULES:
1. NEVER mention sales, discounts, special offers, prices, or freebies UNLESS explicitly written in the user topics above. Speak naturally about services, expertise, dedication, or holiday greetings.
2. Write 2 to 3 natural, engaging sentences.
3. ALWAYS include 2-3 UNIQUE, highly relevant hashtags derived SPECIFICALLY from the business niche. Do NOT use generic hashtags like #LocalBusiness.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
    for (const model of modelsToTry) {
      try {
        const response = await aiClient.models.generateContent({ model, contents: prompt });
        let text = response.text || (response.candidates?.[0]?.content?.parts?.map(p => p.text).join(''));
        if (text && text.trim().length > 0) {
          return text.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        console.warn(`[Gemini AI] Model ${model} failed...`);
      }
    }
  }

  return `At ${locationName || 'our business'}, we take pride in delivering exceptional ${category || 'services'} for our local clients. Visit us today! #${(locationName || 'Business').replace(/\s+/g, '')} #${(category || 'Service').replace(/\s+/g, '')}`;
}

function generateProfessionalPosterSvg(businessName, category, postText, topicInput, enableFestivals, enableReviewSpotlights) {
  const safeName = (businessName || 'Our Business').toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let isFestival = enableFestivals || postText.toLowerCase().includes('festiv') || postText.toLowerCase().includes('season') || postText.toLowerCase().includes('diwali') || postText.toLowerCase().includes('holiday');
  let isReview = enableReviewSpotlights || postText.toLowerCase().includes('review') || postText.toLowerCase().includes('star');

  let headline = topicInput && topicInput.trim().length > 3 ? topicInput : "";
  if (!headline) {
    if (isFestival) headline = "Celebrating Festival Season Together";
    else if (isReview) headline = "Trusted by Our Local Community";
    else headline = `Expert ${safeCat} & Craftsmanship`;
  }
  if (headline.length > 38) headline = headline.substring(0, 35) + "...";
  const safeHeadline = headline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let badge = "★ VERIFIED QUALITY SERVICE";
  if (isFestival) badge = "✨ FESTIVE CELEBRATION GREETINGS";
  else if (isReview) badge = "⭐⭐⭐⭐⭐ 5-STAR CUSTOMER SPOTLIGHT";

  const archetype = Math.floor(Math.random() * 4);
  let svgContent = '';

  if (archetype === 0) {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg0" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0f172a"/><stop offset="50%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#312e81"/>
          </linearGradient>
          <linearGradient id="glow0" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="630" fill="url(#bg0)"/>
        <circle cx="1050" cy="120" r="280" fill="#38bdf8" opacity="0.12" filter="blur(50px)"/>
        <polygon points="0,500 400,630 0,630" fill="#6366f1" opacity="0.25"/>
        <polygon points="1200,0 1200,250 950,0" fill="#38bdf8" opacity="0.15"/>
        <rect x="90" y="90" width="${badge.length * 9.5 + 32}" height="36" rx="18" fill="url(#glow0)"/>
        <text x="106" y="113" fill="#0f172a" font-family="system-ui, sans-serif" font-weight="800" font-size="13" letter-spacing="1.5">${badge}</text>
        <text x="90" y="230" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="52" letter-spacing="-1">${safeHeadline}</text>
        <rect x="90" y="275" width="140" height="6" rx="3" fill="#38bdf8"/>
        <g transform="translate(90, 440)">
          <rect width="1020" height="110" rx="16" fill="#ffffff" fill-opacity="0.06" stroke="#38bdf8" stroke-width="1.5" stroke-opacity="0.3"/>
          <text x="40" y="48" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="800" font-size="30" letter-spacing="1">${safeName}</text>
          <text x="40" y="80" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="16" letter-spacing="0.5">${safeCat} • Verified Google Business</text>
        </g>
      </svg>
    `;
  } else if (archetype === 1) {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#451a03"/><stop offset="50%" stop-color="#78350f"/><stop offset="100%" stop-color="#92400e"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="630" fill="url(#bg1)"/>
        <circle cx="150" cy="120" r="180" fill="#fbbf24" opacity="0.2" filter="blur(60px)"/>
        <circle cx="1050" cy="500" r="220" fill="#fde047" opacity="0.15" filter="blur(70px)"/>
        <rect x="50" y="50" width="1100" height="530" rx="12" fill="none" stroke="#fbbf24" stroke-width="2" stroke-opacity="0.4"/>
        <rect x="90" y="90" width="${badge.length * 9.5 + 32}" height="36" rx="6" fill="#fbbf24" fill-opacity="0.2" stroke="#fbbf24" stroke-width="1.5"/>
        <text x="106" y="113" fill="#fbbf24" font-family="system-ui, sans-serif" font-weight="800" font-size="13" letter-spacing="1.5">${badge}</text>
        <text x="90" y="240" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="54" letter-spacing="-1">${safeHeadline}</text>
        <g transform="translate(90, 420)">
          <text x="0" y="35" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="38" letter-spacing="1">${safeName}</text>
          <text x="0" y="72" fill="#fbbf24" font-family="system-ui, sans-serif" font-weight="700" font-size="18" letter-spacing="1">${safeCat} • Professional Local Service</text>
        </g>
      </svg>
    `;
  } else if (archetype === 2) {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg2" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#090d16"/><stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="630" fill="url(#bg2)"/>
        <rect x="70" y="70" width="1060" height="490" rx="24" fill="#0b1329" stroke="#38bdf8" stroke-width="2" stroke-opacity="0.35"/>
        <rect x="120" y="120" width="${badge.length * 9.5 + 32}" height="36" rx="18" fill="#38bdf8" fill-opacity="0.15" stroke="#38bdf8" stroke-width="1.5"/>
        <text x="136" y="143" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="800" font-size="13" letter-spacing="1.5">${badge}</text>
        <text x="120" y="265" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="50" letter-spacing="-0.5">${safeHeadline}</text>
        <line x1="120" y1="330" x2="400" y2="330" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
        <g transform="translate(120, 420)">
          <text x="0" y="30" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="34" letter-spacing="1">${safeName}</text>
          <text x="0" y="65" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="17" letter-spacing="0.5">${safeCat} • Verified Google Business</text>
        </g>
      </svg>
    `;
  } else {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg3" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#022c22"/><stop offset="50%" stop-color="#064e3b"/><stop offset="100%" stop-color="#047857"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="630" fill="url(#bg3)"/>
        <circle cx="1000" cy="150" r="260" fill="#34d399" opacity="0.15" filter="blur(60px)"/>
        <rect x="90" y="90" width="${badge.length * 9.5 + 32}" height="36" rx="18" fill="#34d399" fill-opacity="0.2" stroke="#34d399" stroke-width="1.5"/>
        <text x="106" y="113" fill="#34d399" font-family="system-ui, sans-serif" font-weight="800" font-size="13" letter-spacing="1.5">${badge}</text>
        <text x="90" y="245" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="52" letter-spacing="-1">${safeHeadline}</text>
        <g transform="translate(90, 420)">
          <rect width="1020" height="110" rx="16" fill="#065f46" fill-opacity="0.4" stroke="#34d399" stroke-width="1.5" stroke-opacity="0.4"/>
          <text x="40" y="48" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="30" letter-spacing="1">${safeName}</text>
          <text x="40" y="80" fill="#34d399" font-family="system-ui, sans-serif" font-weight="700" font-size="16" letter-spacing="0.5">${safeCat} • Expert Local Services</text>
        </g>
      </svg>
    `;
  }

  const base64Svg = Buffer.from(svgContent.trim()).toString('base64');
  return `data:image/svg+xml;base64,${base64Svg}`;
}

app.post('/api/auto-posts/test-generate', async (req, res) => {
  try {
    const { userId, businessId, locationName, category, topics, enableFestivals, enableReviewSpotlights, spotlightReviews } = req.body;
    const bName = locationName || 'Our Business';
    const bCat = category || 'Local Business';
    const showReviewSpotlight = Boolean(enableReviewSpotlights || spotlightReviews);

    const postText = await generateAutoPostText(bName, bCat, topics, enableFestivals, showReviewSpotlight);
    const finalImageUrl = generateProfessionalPosterSvg(bName, bCat, postText, topics, enableFestivals, showReviewSpotlight);

    res.json({ success: true, postText, imageUrl: finalImageUrl, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auto-posts/history/:businessId', async (req, res) => {
  try {
    res.json({ success: true, posts: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/user', '/api/user/me'], async (req, res) => {
  const userId = req.query.userId || req.headers.authorization;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// FIXED: Removed duplicate async keyword
app.get('/api/businesses', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'Error' });
    const formattedBusinesses = (user.locations || []).locs => (user.locations || []).map(loc => ({
      id: loc.locationId,
      name: loc.locationName,
      rating: (loc.rating || 5.0).toFixed(1),
      reviewCount: loc.reviewCount || 0,
      address: loc.address || '',
      subscriptionStatus: loc.subscriptionStatus || 'free'
    }));
    res.json(user.locations.map(loc => ({
      id: loc.locationId,
      name: loc.locationName,
      rating: (loc.rating || 5.0).toFixed(1),
      reviewCount: loc.reviewCount || 0,
      address: loc.address || '',
      subscriptionStatus: loc.subscriptionStatus || 'free'
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
