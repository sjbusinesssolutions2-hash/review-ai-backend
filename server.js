/**
 * SJbs.AI - Production GBP Automation Engine
 * Fully Dynamic Real-Time Calendar Festivals + Real Reviews & Custom Industry SVG Art
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

// FULLY DYNAMIC CALENDAR FESTIVAL DETECTOR
// Evaluates exact date dynamically using JS Date() object
function getDynamicFestivalForToday() {
  const now = new Date();
  const m = now.getMonth(); // 0-indexed: 0=Jan, 9=Oct, 10=Nov, 11=Dec
  const d = now.getDate();

  // Full dynamic yearly Indian & major festival calendar database
  if (m === 0) { // January
    if (d >= 12 && d <= 16) return { name: "Makar Sankranti 🪁", subtitle: "Kites, Harvest Joy & Bright Horizons", tag: "🪁 HARVEST FESTIVAL", artType: "sankranti" };
    if (d >= 24 && d <= 27) return { name: "Republic Day 🇮🇳", subtitle: "Honor, Pride & Glory of the Nation", tag: "🇮🇳 REPUBLIC DAY", artType: "patriot" };
  } else if (m === 2) { // March
    if (d >= 10 && d <= 26) return { name: "Happy Holi 🎨", subtitle: "Festival of Colors, Unity & Joy", tag: "🎨 HOLI SPECIAL", artType: "holi" };
  } else if (m === 7) { // August
    if (d >= 12 && d <= 17) return { name: "Independence Day 🇮🇳", subtitle: "Freedom, Unity & National Pride", tag: "🇮🇳 INDEPENDENCE DAY", artType: "patriot" };
    if (d >= 20 && d <= 30) return { name: "Raksha Bandhan 🧵", subtitle: "Celebrating Unbreakable Bonds of Protection", tag: "🧵 RAKHI SPECIAL", artType: "rakhi" };
  } else if (m === 8) { // September
    if (d >= 5 && d <= 20) return { name: "Ganesh Chaturthi 🐘", subtitle: "Welcoming Lord Ganesha with Devotion & Joy", tag: "🐘 GANESHOTSAV", artType: "devotional" };
  } else if (m === 9) { // October
    if (d >= 1 && d <= 15) return { name: "Shubh Navratri & Dussehra 🏹", subtitle: "Triumph of Virtue, Light & Energy", tag: "🏹 DUSSEHRA SPECIAL", artType: "devotional" };
    if (d >= 20 && d <= 31) return { name: "Shubh Dhanteras & Diwali 🪔", subtitle: "Festival of Lights, Hope & Prosperity", tag: "🪔 HAPPY DIWALI 2026", artType: "diwali" };
  } else if (m === 10) { // November
    if (d <= 12) return { name: "Shubh Diwali & Chhath Puja 🪔", subtitle: "Lights, Purity & Divine Sun Blessings", tag: "🪔 DIWALI & CHHATH", artType: "diwali" };
    if (d >= 18 && d <= 28) return { name: "Guru Nanak Jayanti & Dev Deepavali 🪔", subtitle: "Light of Wisdom, Peace & Universal Grace", tag: "🪔 GURPURAB CELEBRATION", artType: "diwali" };
  } else if (m === 11) { // December
    if (d >= 15 && d <= 26) return { name: "Merry Christmas 🎄", subtitle: "Season of Joy, Gratitude & Peace", tag: "🎄 SEASONAL GREETINGS", artType: "christmas" };
    if (d >= 27) return { name: "Happy New Year 🎆", subtitle: "Fresh Start, Peak Performance & Great Beginnings", tag: "🎆 NEW YEAR 2027", artType: "newyear" };
  }

  // Fallback to current seasonal highlight
  return { name: "Seasonal Business Spotlight ✨", subtitle: "Serving Our Local Community with Excellence", tag: "✨ BUSINESS SPOTLIGHT", artType: "general" };
}

// Strict XML string escape function so SVGs never crash
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

  if (topics && topics.trim().length > 0) {
    contextPrompt += `User Focus Topics: "${topics}".
`;
  }
  if (enableFestivals) {
    contextPrompt += `Festival Option: ENABLED. Current Active Calendar Festival for today is "${activeFestival.name}". Incorporate warm wishes for "${activeFestival.name}" into the post.
`;
  }
  if (enableReviewSpotlights) {
    contextPrompt += `Review Spotlight Option: ENABLED. Highlight 5-star customer trust and glowing feedback for the business.
`;
  }

  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we take immense pride in delivering top-tier ${category || 'services'}. ${enableFestivals ? `Wishing our entire community a joyful ${activeFestival.name}!` : 'Visit our workshop today for expert service.'} #${(locationName || 'Business').replace(/\s+/g, '')}`;
  }

  const prompt = `You are an expert social media copywriter creating a Google Business Profile post.

Context:
${contextPrompt}

STRICT INSTRUCTIONS:
1. Write 2 to 3 engaging, authentic sentences tailored specifically to the business name, category, and enabled options above.
2. NEVER invent fake discounts, sales, or prices unless explicitly written in topics.
3. If Festival Option is ENABLED, explicitly name "${activeFestival.name}"!
4. Always end with 2-3 unique, relevant hashtags.`;

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

  return `At ${locationName || 'our business'}, we take pride in delivering master ${category || 'services'}. ${enableFestivals ? `Wishing everyone a very happy ${activeFestival.name}!` : 'Visit us today!'} #${(locationName || 'Business').replace(/\s+/g, '')}`;
}

// FULLY DYNAMIC SVG GRAPHICS ENGINE
function generateGraphicalSocialPostSvg(businessName, category, postText, topicInput, enableFestivals, enableReviewSpotlights) {
  const safeName = xmlEscape((businessName || 'Our Business').toUpperCase());
  const safeCat = xmlEscape(category || 'Professional Services');

  const activeFestival = getDynamicFestivalForToday();
  const lowerText = postText.toLowerCase();
  const lowerName = (businessName || '').toLowerCase();
  const lowerCat = (category || '').toLowerCase();
  const lowerTopic = (topicInput || '').toLowerCase();

  let isFestival = enableFestivals || lowerText.includes('diwali') || lowerText.includes('dhanteras') || lowerText.includes('festival') || lowerText.includes('holiday') || lowerText.includes('christmas');
  let isReview = enableReviewSpotlights || lowerText.includes('review') || lowerText.includes('star') || lowerText.includes('feedback');
  let isCricket = lowerName.includes('bat') || lowerCat.includes('cricket') || lowerTopic.includes('bat') || lowerTopic.includes('repair') || lowerTopic.includes('knock');

  // Headline Decision Logic
  let headline = topicInput && topicInput.trim().length > 3 ? xmlEscape(topicInput) : "";
  if (!headline) {
    if (isFestival) headline = xmlEscape(activeFestival.name);
    else if (isReview) headline = "5-Star Community Trust";
    else headline = `Expert ${safeCat}`;
  }
  if (headline.length > 32) headline = headline.substring(0, 29) + "...";

  let badgeText = xmlEscape(isFestival ? activeFestival.tag : (isReview ? "⭐ 5-STAR VERIFIED REVIEWS" : "⚡ CRAFTSMANSHIP SPOTLIGHT"));
  let subText = xmlEscape(isFestival ? activeFestival.subtitle : (isReview ? "Recognized for Outstanding Service & Excellence" : "Dedicated Care & Precision Handling Every Day"));

  // DYNAMIC SVG ARTWORKS
  
  // 1. Diwali / Festive Diya Lamp
  const vectorDiyaArt = `
    <g transform="translate(540, 640) scale(1.35)">
      <path d="M -80 0 C -80 45, 80 45, 80 0 C 50 15, -50 15, -80 0 Z" fill="#f59e0b" stroke="#d97706" stroke-width="3"/>
      <path d="M 0 -5 C -18 -35, 0 -85, 0 -85 C 0 -85, 18 -35, 0 -5 Z" fill="#fef08a" opacity="0.9"/>
      <path d="M 0 -10 C -10 -30, 0 -65, 0 -65 C 0 -65, 10 -30, 0 -10 Z" fill="#f97316"/>
      <circle cx="0" cy="-40" r="45" fill="#fef08a" opacity="0.35" filter="blur(16px)"/>
    </g>
  `;

  // 2. Cricket Bat & Ball Gear
  const vectorCricketArt = `
    <g transform="translate(540, 630) scale(1.25)">
      <path d="M -15 -100 L 15 -100 L 18 10 L 22 80 C 22 100, -22 100, -22 80 L -18 10 Z" fill="#d97706" stroke="#78350f" stroke-width="4"/>
      <rect x="-6" y="-180" width="12" height="85" rx="6" fill="#1e293b" stroke="#ffffff" stroke-width="2"/>
      <circle cx="65" cy="40" r="28" fill="#dc2626" stroke="#991b1b" stroke-width="3"/>
      <path d="M 45 25 C 60 40, 70 50, 85 55" stroke="#ffffff" stroke-width="3" stroke-dasharray="4,4" fill="none"/>
    </g>
  `;

  // 3. 5-Star Seal / Trophy
  const vectorReviewArt = `
    <g transform="translate(540, 630) scale(1.2)">
      <circle cx="0" cy="0" r="80" fill="#0284c7" fill-opacity="0.25" stroke="#38bdf8" stroke-width="3"/>
      <polygon points="0,-45 14,-15 45,-10 22,12 28,42 0,25 -28,42 -22,12 -45,-10 -14,-15" fill="#fbbf24" stroke="#f59e0b" stroke-width="2"/>
    </g>
  `;

  // 4. Modern Business Shield
  const vectorBusinessArt = `
    <g transform="translate(540, 630) scale(1.2)">
      <path d="M 0 -60 L 50 -30 L 50 20 C 50 55, 0 80, 0 80 C 0 80, -50 55, -50 20 L -50 -30 Z" fill="#38bdf8" fill-opacity="0.2" stroke="#38bdf8" stroke-width="3"/>
      <polyline points="-20,0 -5,15 25,-15" fill="none" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  `;

  let chosenGraphicArt = vectorBusinessArt;
  if (isFestival) chosenGraphicArt = vectorDiyaArt;
  else if (isReview) chosenGraphicArt = vectorReviewArt;
  else if (isCricket) chosenGraphicArt = vectorCricketArt;

  const bgGradient = isFestival 
    ? `<radialGradient id="bgGlow" cx="50%" cy="50%" r="75%"><stop offset="0%" stop-color="#7c2d12"/><stop offset="100%" stop-color="#451a03"/></radialGradient>`
    : `<radialGradient id="bgGlow" cx="50%" cy="50%" r="75%"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#0f172a"/></radialGradient>`;

  const accentColor = isFestival ? "#fbbf24" : "#38bdf8";

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    ${bgGradient}
  </defs>
  <rect width="1080" height="1080" fill="url(#bgGlow)"/>
  
  <rect x="40" y="40" width="1000" height="1000" rx="28" fill="none" stroke="${accentColor}" stroke-width="4" stroke-opacity="0.6"/>
  
  <g transform="translate(540, 140)">
    <rect x="-220" y="0" width="440" height="56" rx="28" fill="${accentColor}" fill-opacity="0.2" stroke="${accentColor}" stroke-width="2"/>
    <text x="0" y="36" fill="${accentColor}" font-family="system-ui, sans-serif" font-weight="900" font-size="18" letter-spacing="2" text-anchor="middle">${badgeText}</text>
  </g>
  
  <text x="540" y="310" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="70" letter-spacing="-1" text-anchor="middle">${headline}</text>
  <text x="540" y="380" fill="${isFestival ? '#fef08a' : '#38bdf8'}" font-family="system-ui, sans-serif" font-weight="700" font-size="26" text-anchor="middle">${subText}</text>
  
  ${chosenGraphicArt}
  
  <g transform="translate(540, 880)">
    <rect x="-420" y="0" width="840" height="110" rx="20" fill="#000000" fill-opacity="0.45" stroke="${accentColor}" stroke-width="2"/>
    <text x="0" y="48" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="36" letter-spacing="1" text-anchor="middle">${safeName}</text>
    <text x="0" y="82" fill="${accentColor}" font-family="system-ui, sans-serif" font-weight="700" font-size="20" letter-spacing="0.5" text-anchor="middle">${safeCat} • Verified Business</text>
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
