/**
 * SJbs.AI - Production GBP Automation Engine
 * Fully Randomized Multi-Layout SVG Generator + No-Offer AI Copywriter
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

// Organic Business Post Generator (Strictly NO invented offers)
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

// Truly Unique, Multi-Layout Dynamic SVG Banner Generator
function generateContextualSvgBanner(businessName, category, postText, topicInput, enableFestivals, enableReviewSpotlights) {
  const safeName = (businessName || 'Our Business').toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let isFestival = enableFestivals || postText.toLowerCase().includes('festiv') || postText.toLowerCase().includes('season') || postText.toLowerCase().includes('diwali') || postText.toLowerCase().includes('holiday');
  let isReview = enableReviewSpotlights || postText.toLowerCase().includes('review') || postText.toLowerCase().includes('star');

  // Extract a unique dynamic headline from topics or sentences
  let headline = topicInput && topicInput.trim().length > 3 ? topicInput : "";
  if (!headline) {
    if (isFestival) headline = "Warm Festive Season Wishes";
    else if (isReview) headline = "Rated 5-Stars by Our Community";
    else headline = `Expert ${safeCat} Services`;
  }
  if (headline.length > 36) headline = headline.substring(0, 33) + "...";
  const safeHeadline = headline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let badgeText = "EXPERT CRAFTSMANSHIP";
  if (isFestival) badgeText = "✨ FESTIVE CELEBRATION";
  else if (isReview) badgeText = "⭐ 5-STAR CUSTOMER TRUST";

  // Randomize among 3 completely distinct visual layout templates per generation!
  const layoutStyle = Math.floor(Math.random() * 3); // 0, 1, or 2

  // Diverse color palettes
  const palettes = [
    { bg1: '#0f172a', bg2: '#0369a1', accent: '#38bdf8', card: '#0b1329', text: '#ffffff' },
    { bg1: '#064e3b', bg2: '#065f46', accent: '#34d399', card: '#022c22', text: '#ffffff' },
    { bg1: '#3b0764', bg2: '#6b21a8', accent: '#fbbf24', card: '#2e1065', text: '#ffffff' },
    { bg1: '#4c0519', bg2: '#881337', accent: '#fda4af', card: '#2a0815', text: '#ffffff' }
  ];
  const t = palettes[Math.floor(Math.random() * palettes.length)];
  if (isFestival) {
    t.bg1 = '#3b0764'; t.bg2 = '#7e22ce'; t.accent = '#fbbf24'; t.card = '#2e1065';
  }

  let svgContent = '';

  if (layoutStyle === 0) {
    // LAYOUT 0: Modern Centered Glass Card with Floating Orbs
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${t.bg1}"/><stop offset="100%" stop-color="${t.bg2}"/>
          </linearGradient>
          <filter id="shadow"><feDropShadow dx="0" dy="20" stdDeviation="30" flood-color="#000" flood-opacity="0.5"/></filter>
        </defs>
        <rect width="1200" height="630" fill="url(#bg)"/>
        <circle cx="200" cy="150" r="220" fill="${t.accent}" opacity="0.15" filter="blur(60px)"/>
        <circle cx="1000" cy="500" r="260" fill="${t.accent}" opacity="0.1" filter="blur(70px)"/>
        
        <g filter="url(#shadow)">
          <rect x="120" y="90" width="960" height="450" rx="28" fill="${t.card}" stroke="${t.accent}" stroke-width="2" stroke-opacity="0.5"/>
        </g>
        
        <rect x="180" y="150" width="${badgeText.length * 11 + 36}" height="38" rx="19" fill="${t.accent}" fill-opacity="0.2" stroke="${t.accent}" stroke-width="1.5"/>
        <text x="200" y="175" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="700" font-size="14" letter-spacing="1.5">${badgeText}</text>
        
        <text x="180" y="270" fill="${t.text}" font-family="system-ui, sans-serif" font-weight="800" font-size="46" letter-spacing="-0.5">${safeHeadline}</text>
        
        <line x1="180" y1="330" x2="520" y2="330" stroke="${t.accent}" stroke-width="4" stroke-linecap="round"/>
        
        <text x="180" y="430" fill="${t.text}" font-family="system-ui, sans-serif" font-weight="800" font-size="32" letter-spacing="1">${safeName}</text>
        <text x="180" y="462" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="600" font-size="17" opacity="0.9">${safeCat} • Verified Business</text>
      </svg>
    `;
  } else if (layoutStyle === 1) {
    // LAYOUT 1: Split Dynamic Accent Bar with Sleek Left Stripe
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="${t.bg2}"/><stop offset="100%" stop-color="${t.bg1}"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="630" fill="url(#bg1)"/>
        <rect x="0" y="0" width="24" height="630" fill="${t.accent}"/>
        
        <rect x="100" y="120" width="160" height="6" rx="3" fill="${t.accent}"/>
        <text x="100" y="180" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="800" font-size="16" letter-spacing="2">${badgeText}</text>
        
        <text x="100" y="275" fill="${t.text}" font-family="system-ui, sans-serif" font-weight="800" font-size="52" letter-spacing="-1">${safeHeadline}</text>
        
        <rect x="100" y="340" width="1000" height="2" fill="${t.accent}" opacity="0.3"/>
        
        <text x="100" y="440" fill="${t.text}" font-family="system-ui, sans-serif" font-weight="800" font-size="36" letter-spacing="1">${safeName}</text>
        <text x="100" y="475" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="600" font-size="19" opacity="0.9">${safeCat} • Official Google Business Profile</text>
      </svg>
    `;
  } else {
    // LAYOUT 2: Geometric Minimalist Frame with Top Header Badge
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="bg2" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="${t.bg1}"/><stop offset="100%" stop-color="${t.bg2}"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="630" fill="url(#bg2)"/>
        
        <rect x="70" y="70" width="1060" height="490" rx="16" fill="none" stroke="${t.accent}" stroke-width="2" stroke-opacity="0.35"/>
        <circle cx="1100" cy="100" r="180" fill="${t.accent}" opacity="0.08" filter="blur(40px)"/>
        
        <rect x="130" y="120" width="${badgeText.length * 11 + 36}" height="38" rx="8" fill="${t.accent}" fill-opacity="0.25"/>
        <text x="150" y="145" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="700" font-size="14" letter-spacing="1.5">${badgeText}</text>
        
        <text x="130" y="260" fill="${t.text}" font-family="system-ui, sans-serif" font-weight="800" font-size="48" letter-spacing="-0.5">${safeHeadline}</text>
        
        <g transform="translate(130, 420)">
          <text x="0" y="25" fill="${t.text}" font-family="system-ui, sans-serif" font-weight="800" font-size="34" letter-spacing="1">${safeName}</text>
          <text x="0" y="58" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="600" font-size="18" opacity="0.9">${safeCat}</text>
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
    const finalImageUrl = generateContextualSvgBanner(bName, bCat, postText, topics, enableFestivals, showReviewSpotlight);

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

app.get('/api/businesses', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'Error' });
    const formattedBusinesses = (user.locations || []).map(loc => ({
      id: loc.locationId,
      name: loc.locationName,
      rating: (loc.rating || 5.0).toFixed(1),
      reviewCount: loc.reviewCount || 0,
      address: loc.address || '',
      subscriptionStatus: loc.subscriptionStatus || 'free'
    }));
    res.json(formattedBusinesses);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
