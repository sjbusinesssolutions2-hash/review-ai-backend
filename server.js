/**
 * SJbs.AI - Production GBP Automation Engine
 * Fully Independent Algorithmic Social Poster & AI Post Generator
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

// REAL-TIME DYNAMIC CALENDAR FESTIVAL DETECTOR
function getDynamicFestivalForToday() {
  const now = new Date();
  const m = now.getMonth();
  const d = now.getDate();

  if (m === 0 && d >= 12 && d <= 16) return { name: "Makar Sankranti", subtitle: "Kites, Harvest Joy & Bright Horizons", tag: "🪁 HARVEST FESTIVAL" };
  if (m === 2 && d >= 10 && d <= 26) return { name: "Happy Holi", subtitle: "Festival of Colors, Unity & Joy", tag: "🎨 HOLI SPECIAL" };
  if (m === 7 && d >= 12 && d <= 17) return { name: "Independence Day", subtitle: "Freedom, Unity & National Pride", tag: "🇮🇳 INDEPENDENCE DAY" };
  if (m === 9 && d >= 20 && d <= 31) return { name: "Shubh Dhanteras & Diwali", subtitle: "Festival of Lights, Hope & Prosperity", tag: "🪔 DIWALI SPECIAL" };
  if (m === 10 && d <= 12) return { name: "Shubh Diwali & Chhath Puja", subtitle: "Lights, Purity & Divine Sun Blessings", tag: "🪔 DIWALI & CHHATH" };
  if (m === 11 && d >= 15 && d <= 26) return { name: "Merry Christmas", subtitle: "Season of Joy, Gratitude & Peace", tag: "🎄 SEASONAL GREETINGS" };
  if (m === 11 && d >= 27) return { name: "Happy New Year", subtitle: "Fresh Start, Peak Performance & Great Beginnings", tag: "🎆 NEW YEAR 2027" };

  return { name: "Business Excellence Spotlight", subtitle: "Serving Our Local Community with Distinction", tag: "✨ COMMUNITY SPOTLIGHT" };
}

function xmlEscape(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, 'and')
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/"/g, '')
    .replace(/'/g, '');
}

async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  const activeFestival = getDynamicFestivalForToday();
  const todayDateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let contextPrompt = `Today's Date: ${todayDateStr}.
Business Name: "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
`;
  if (topics && topics.trim().length > 0) contextPrompt += `Focus Topics / Services: "${topics}".
`;
  if (enableFestivals) contextPrompt += `Festival Option: ENABLED (${activeFestival.name}). Include warm wishes for ${activeFestival.name}.
`;
  if (enableReviewSpotlights) contextPrompt += `Review Spotlight Option: ENABLED. Highlight 5-star customer feedback and trust.
`;

  if (!geminiKeys || geminiKeys.length === 0) {
    let baseText = `At ${locationName || 'our business'}, we take immense pride in delivering top-tier ${category || 'services'}. `;
    if (enableFestivals) baseText += `Wishing everyone a very happy ${activeFestival.name}! `;
    if (enableReviewSpotlights) baseText += `We are deeply grateful for your glowing 5-star reviews and continued trust. `;
    baseText += `#${(locationName || 'Business').replace(/\s+/g, '')} #LocalExcellence`;
    return baseText;
  }

  const prompt = `You are an expert social media copywriter creating a Google Business Profile post.
Context:
${contextPrompt}

STRICT INSTRUCTIONS:
1. Write 2 to 3 engaging, authentic sentences tailored specifically to the business name, category, and enabled options.
2. DO NOT use markdown formatting (no asterisks ** or # inside the text body).
3. If Festival is ENABLED, explicitly mention "${activeFestival.name}".
4. If Review Spotlight is ENABLED, mention 5-star trust.
5. End with 2-3 relevant hashtags.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
    for (const model of modelsToTry) {
      try {
        const response = await aiClient.models.generateContent({ model, contents: prompt });
        let text = response.text || (response.candidates?.[0]?.content?.parts?.map(p => p.text).join(''));
        if (text && text.trim().length > 0) {
          return text.trim().replace(/^["']|["']$/g, '').replace(/[*_#]/g, '');
        }
      } catch (err) {
        console.warn(`[Gemini AI] Model ${model} failed...`);
      }
    }
  }

  return `At ${locationName || 'our business'}, we deliver exceptional craftsmanship. ${enableFestivals ? `Wishing you a wonderful ${activeFestival.name}!` : ''} #${(locationName || 'Business').replace(/\s+/g, '')}`;
}

// FULLY INDEPENDENT ALGORITHMIC SVG POSTER GENERATOR WITH INDEPENDENT RANDOM VARIATION
function generateGraphicalSocialPostSvg(businessName, category, postText, topicInput, enableFestivals, enableReviewSpotlights) {
  const safeName = xmlEscape((businessName || 'Our Business').toUpperCase());
  const safeCat = xmlEscape(category || 'Professional Services');

  const activeFestival = getDynamicFestivalForToday();
  const lowerText = (postText || '').toLowerCase();
  
  let isFestival = enableFestivals || lowerText.includes('diwali') || lowerText.includes('dhanteras') || lowerText.includes('festival');
  let isReview = enableReviewSpotlights || lowerText.includes('review') || lowerText.includes('star') || lowerText.includes('trust');
  
  // COMPLETELY INDEPENDENT COLOR PALETTES (Randomly selected or rotating on every click)
  const palettes = [
    { bg1: '#0f172a', bg2: '#1e293b', accent: '#38bdf8', glow: 'rgba(56, 189, 248, 0.2)' }, // Slate Blue
    { bg1: '#022c22', bg2: '#064e3b', accent: '#34d399', glow: 'rgba(52, 211, 153, 0.2)' }, // Deep Emerald
    { bg1: '#451a03', bg2: '#7c2d12', accent: '#fbbf24', glow: 'rgba(251, 191, 36, 0.25)' }, // Warm Amber
    { bg1: '#311042', bg2: '#581c87', accent: '#c084fc', glow: 'rgba(192, 132, 252, 0.2)' }, // Royal Purple
    { bg1: '#18181b', bg2: '#27272a', accent: '#f43f5e', glow: 'rgba(244, 63, 94, 0.2)' }   // Modern Rose Dark
  ];

  // Rotate theme independently on every generation request using Math.random() so it never repeats the same colors!
  const theme = palettes[Math.floor(Math.random() * palettes.length)];

  // Dynamic Headline
  let headline = topicInput && topicInput.trim().length > 3 ? xmlEscape(topicInput) : "";
  if (!headline) {
    if (isFestival) headline = xmlEscape(activeFestival.name);
    else if (isReview) headline = "5-Star Community Trust";
    else headline = `Expert ${safeCat}`;
  }
  if (headline.length > 34) headline = headline.substring(0, 31) + "...";

  let badgeText = xmlEscape(isFestival ? activeFestival.tag : (isReview ? "⭐ 5-STAR VERIFIED REVIEWS" : `⚡ ${safeCat.toUpperCase()} SPOTLIGHT`));
  let subText = xmlEscape(isFestival ? activeFestival.subtitle : (isReview ? "Recognized for Outstanding Service & Excellence" : "Dedicated Care & Precision Handling Every Day"));

  // INDEPENDENT VECTOR ART GENERATOR (Randomly picks among multiple independent vector compositions on every click)
  const vectorArtChoices = [
    // Choice 0: Geometric Tech Emblem
    `
      <g transform="translate(540, 620)">
        <circle cx="0" cy="0" r="95" fill="${theme.accent}" fill-opacity="0.1" stroke="${theme.accent}" stroke-width="2"/>
        <rect x="-45" y="-45" width="90" height="90" rx="18" fill="none" stroke="${theme.accent}" stroke-width="3" transform="rotate(45)"/>
        <circle cx="0" cy="0" r="35" fill="${theme.accent}" fill-opacity="0.3"/>
        <path d="M -15 0 L -5 10 L 20 -15" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    `,
    // Choice 1: Star Trust Seal
    `
      <g transform="translate(540, 620)">
        <circle cx="0" cy="0" r="90" fill="${theme.accent}" fill-opacity="0.15" stroke="${theme.accent}" stroke-width="3"/>
        <circle cx="0" cy="0" r="70" fill="none" stroke="${theme.accent}" stroke-width="1.5" stroke-dasharray="6,6"/>
        <g fill="${theme.accent}" transform="scale(1.4) translate(-30, -35)">
          <polygon points="25,5 32,19 48,21 36,32 39,48 25,40 11,48 14,32 2,21 18,19"/>
        </g>
      </g>
    `,
    // Choice 2: Glowing Diya / Spark Emblem
    `
      <g transform="translate(540, 620)">
        <ellipse cx="0" cy="20" rx="120" ry="30" fill="${theme.accent}" opacity="0.2" filter="blur(20px)"/>
        <path d="M -90 10 C -90 55, 90 55, 90 10 C 60 25, -60 25, -90 10 Z" fill="${theme.accent}" stroke="#d97706" stroke-width="3"/>
        <path d="M 0 -10 C -20 -40, 0 -95, 0 -95 C 0 -95, 20 -40, 0 -10 Z" fill="#fef08a" opacity="0.95"/>
        <path d="M 0 -15 C -10 -35, 0 -70, 0 -70 C 0 -70, 10 -35, 0 -15 Z" fill="#f97316"/>
        <circle cx="0" cy="-50" r="50" fill="#fef08a" opacity="0.3" filter="blur(18px)"/>
      </g>
    `,
    // Choice 3: Shield & Checkmark Emblem
    `
      <g transform="translate(540, 620)">
        <path d="M 0 -70 L 60 -35 L 60 25 C 60 65, 0 95, 0 95 C 0 95, -60 65, -60 25 L -60 -35 Z" fill="${theme.accent}" fill-opacity="0.15" stroke="${theme.accent}" stroke-width="3"/>
        <polyline points="-25,-5 -5,15 30,-20" fill="none" stroke="${theme.accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    `
  ];

  // Pick a random vector art piece independently on every click!
  const selectedArt = vectorArtChoices[Math.floor(Math.random() * vectorArtChoices.length)];

  // Fully independent algorithmic SVG layout composition
  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.bg1}"/>
      <stop offset="100%" stop-color="${theme.bg2}"/>
    </linearGradient>
    <radialGradient id="centerGlow" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1080" height="1080" fill="url(#bgGrad)"/>
  <circle cx="540" cy="540" r="500" fill="url(#centerGlow)"/>

  <!-- Algorithmic Border Frame -->
  <rect x="40" y="40" width="1000" height="1000" rx="32" fill="none" stroke="${theme.accent}" stroke-width="4" stroke-opacity="0.55"/>
  <rect x="56" y="56" width="968" height="968" rx="24" fill="none" stroke="${theme.accent}" stroke-width="1.5" stroke-opacity="0.2"/>

  <!-- Badge Pill -->
  <g transform="translate(540, 130)">
    <rect x="-240" y="0" width="480" height="56" rx="28" fill="${theme.accent}" fill-opacity="0.2" stroke="${theme.accent}" stroke-width="2"/>
    <text x="0" y="36" fill="${theme.accent}" font-family="system-ui, sans-serif" font-weight="900" font-size="18" letter-spacing="2" text-anchor="middle">${badgeText}</text>
  </g>

  <!-- Dynamic Headline & Subtitle -->
  <text x="540" y="310" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="70" letter-spacing="-1" text-anchor="middle">${headline}</text>
  <text x="540" y="385" fill="${theme.accent}" font-family="system-ui, sans-serif" font-weight="700" font-size="26" text-anchor="middle">${subText}</text>

  <!-- Independent Random Vector Art -->
  ${selectedArt}

  <!-- Bottom Branding Footer -->
  <g transform="translate(540, 880)">
    <rect x="-420" y="0" width="840" height="110" rx="20" fill="#000000" fill-opacity="0.5" stroke="${theme.accent}" stroke-width="2"/>
    <text x="0" y="48" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="36" letter-spacing="1" text-anchor="middle">${safeName}</text>
    <text x="0" y="82" fill="${theme.accent}" font-family="system-ui, sans-serif" font-weight="700" font-size="20" letter-spacing="0.5" text-anchor="middle">${safeCat} • Verified Business Profile</text>
  </g>
</svg>`;

  const base64Svg = Buffer.from(svgContent.trim(), 'utf-8').toString('base64');
  return `data:image/svg+xml;base64,${base64Svg}`;
}

app.post('/api/auto-posts/test-generate', async (req, res) => {
  try {
    const { userId, businessId, locationName, category, topics, enableFestivals, enableReviewSpotlights, spotlightReviews } = req.body;
    const bName = locationName || 'Our Business';
    const bCat = category || 'Local Business';
    const showReviewSpotlight = Boolean(enableReviewSpotlights || spotlightReviews);

    const postText = await generateAutoPostText(bName, bCat, topics, enableFestivals, showReviewSpotlight);
    const finalImageUrl = generateGraphicalSocialPostSvg(bName, bCat, postText, topics, enableFestivals, showReviewSpotlight);

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
  if (-!userId) return res.status(400).json({ error: 'Missing userId' });
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
