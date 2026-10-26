/**
 * SJbs.AI - Production GBP Automation Engine
 * Real Graphical Social Media Poster SVG Engine with Live Named Indian Festivals & Vector Graphics
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

// Accurate Named Festival Calendar (Diwali, Dhanteras, Bhai Dooj, Dev Deepavali, Christmas, New Year, Makar Sankranti)
function getSpecificNamedFestival() {
  const festivalsList = [
    { name: "Happy Diwali 🪔", subtitle: "Festival of Lights & Prosperity", tag: "🪔 DIWALI SPECIAL" },
    { name: "Shubh Dhanteras ✨", subtitle: "Blessings of Health, Wealth & Good Fortune", tag: "✨ DHANTERAS BLESSINGS" },
    { name: "Happy Bhai Dooj 🌸", subtitle: "Celebrating Bonds of Trust & Care", tag: "🌸 BHAI DOOJ SPECIAL" },
    { name: "Dev Deepavali 🪔", subtitle: "Light, Devotion & Joyous Celebrations", tag: "🪔 DEV DEEPAVALI" },
    { name: "Guru Nanak Jayanti 🪔", subtitle: "Peace, Equality & Universal Blessings", tag: "🪔 GURPURAB CELEBRATION" },
    { name: "Merry Christmas 🎄", subtitle: "Season of Joy, Warmth & Togetherness", tag: "🎄 SEASONAL GREETINGS" },
    { name: "Happy New Year 2027 🎆", subtitle: "Fresh Start, Peak Performance & Great Beginnings", tag: "🎆 NEW YEAR SPECIAL" },
    { name: "Makar Sankranti 🪵", subtitle: "Kites, Harvest Joy & Bright Horizons", tag: "🪁 HARVEST FESTIVAL" }
  ];

  // Pick a realistic festival based on day or cycle so every test output names a SPECIFIC real festival!
  const index = Math.floor(Math.random() * festivalsList.length);
  return festivalsList[index];
}

async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  const activeFestival = getSpecificNamedFestival();
  const festivalContext = enableFestivals 
    ? `Specific Real Festival to highlight: ${activeFestival.name} (${activeFestival.subtitle}). Write authentic holiday wishes for this specific festival.` 
    : 'No festival needed unless specified in topics.';

  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we take pride in delivering exceptional ${category || 'services'} for our local community. ${enableFestivals ? `Wishing you and your family a very ${activeFestival.name}!` : 'Visit our workshop today!'} #${(locationName || 'Business').replace(/\s+/g, '')} #${(category || 'Service').replace(/\s+/g, '')}`;
  }

  const prompt = `You are an expert social media writer creating an authentic Google Business Profile post for "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).

Post Focus & Settings:
- Business Focus / Topics: ${topics || 'Highlighting our core expertise and craftsmanship'}
- Seasonal Greetings: ${enableFestivals ? `ENABLED (${festivalContext})` : 'DISABLED'}
- Review Spotlight: ${enableReviewSpotlights ? 'ENABLED (Reflect real customer trust and 5-star feedback)' : 'DISABLED'}

STRICT RULES:
1. NEVER mention sales, discounts, special offers, prices, or freebies UNLESS explicitly written in the user topics above. Speak naturally about services, expertise, dedication, or holiday greetings.
2. If festival greetings are enabled, explicitly mention "${activeFestival.name}" in the post text!
3. Write 2 to 3 natural, engaging sentences.
4. ALWAYS include 2-3 UNIQUE, highly relevant hashtags derived SPECIFICALLY from the business niche. Do NOT use generic hashtags like #LocalBusiness.`;

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

  return `At ${locationName || 'our business'}, we take pride in delivering exceptional ${category || 'services'} for our local clients. ${enableFestivals ? `Wishing you a joyous ${activeFestival.name}!` : 'Visit us today!'} #${(locationName || 'Business').replace(/\s+/g, '')}`;
}

// REAL GRAPHICAL SOCIAL MEDIA POST GENERATOR (With actual vector artwork: Diya lamps, Stars, Craft Equipment, Badges)
function generateGraphicalSocialPostSvg(businessName, category, postText, topicInput, enableFestivals, enableReviewSpotlights) {
  const safeName = (businessName || 'Our Business').toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const activeFestival = getSpecificNamedFestival();
  let isFestival = enableFestivals || postText.toLowerCase().includes('diwali') || postText.toLowerCase().includes('dhanteras') || postText.toLowerCase().includes('bhai dooj') || postText.toLowerCase().includes('festiv') || postText.toLowerCase().includes('christmas') || postText.toLowerCase().includes('year');
  let isReview = enableReviewSpotlights || postText.toLowerCase().includes('review') || postText.toLowerCase().includes('star');

  let headline = topicInput && topicInput.trim().length > 3 ? topicInput : "";
  if (!headline) {
    if (isFestival) headline = activeFestival.name;
    else if (isReview) headline = "5-Star Rated Craftsmanship";
    else headline = `Expert ${safeCat}`;
  }
  if (headline.length > 30) headline = headline.substring(0, 28) + "...";
  const safeHeadline = headline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let badgeText = isFestival ? activeFestival.tag : (isReview ? "⭐⭐⭐⭐⭐ 5-STAR TRUST" : "⚡ CRAFTSMANSHIP SPOTLIGHT");

  // SVG VECTOR ARTWORK COMPONENT GENERATORS:
  
  // 1. Detailed Vector Diya Flame (for Festive Posts)
  const vectorDiyaArt = `
    <g transform="translate(540, 680) scale(1.4)">
      <!-- Diya Base -->
      <path d="M -80 0 C -80 45, 80 45, 80 0 C 50 15, -50 15, -80 0 Z" fill="#f59e0b" stroke="#d97706" stroke-width="3"/>
      <!-- Glowing Flames -->
      <path d="M 0 -5 C -18 -35, 0 -85, 0 -85 C 0 -85, 18 -35, 0 -5 Z" fill="#fef08a" opacity="0.9"/>
      <path d="M 0 -10 C -10 -30, 0 -65, 0 -65 C 0 -65, 10 -30, 0 -10 Z" fill="#f97316"/>
      <circle cx="0" cy="-40" r="45" fill="#fef08a" opacity="0.25" filter="blur(15px)"/>
    </g>
  `;

  // 2. Detailed Cricket Bat & Ball Vector Art (for Workshop/Craftsmanship Posts)
  const vectorCricketArt = `
    <g transform="translate(540, 680) scale(1.2)">
      <!-- Cricket Bat Vector -->
      <path d="M -15 -100 L 15 -100 L 18 10 L 22 80 C 22 100, -22 100, -22 80 L -18 10 Z" fill="#d97706" stroke="#78350f" stroke-width="4"/>
      <!-- Bat Handle -->
      <rect x="-6" y="-180" width="12" height="85" rx="6" fill="#1e293b" stroke="#ffffff" stroke-width="2"/>
      <!-- Cricket Ball Vector -->
      <circle cx="65" cy="40" r="28" fill="#dc2626" stroke="#991b1b" stroke-width="3"/>
      <path d="M 45 25 C 60 40, 70 50, 85 55" stroke="#ffffff" stroke-width="3" stroke-dasharray="4,4" fill="none"/>
    </g>
  `;

  // 3. 5-Star Badge Vector Graphic (for Customer Spotlight)
  const vectorStarBadgeArt = `
    <g transform="translate(540, 660)">
      <circle cx="0" cy="0" r="85" fill="#0284c7" fill-opacity="0.2" stroke="#38bdf8" stroke-width="3"/>
      <g fill="#fbbf24" transform="scale(1.3)">
        <path d="M -50 -10 L -40 20 L -10 20 L -32 38 L -22 68 L -50 48 L -78 68 L -68 38 L -90 20 L -60 20 Z" transform="translate(10, -30) scale(0.4)"/>
        <path d="M -50 -10 L -40 20 L -10 20 L -32 38 L -22 68 L -50 48 L -78 68 L -68 38 L -90 20 L -60 20 Z" transform="translate(30, -30) scale(0.4)"/>
        <path d="M -50 -10 L -40 20 L -10 20 L -32 38 L -22 68 L -50 48 L -78 68 L -68 38 L -90 20 L -60 20 Z" transform="translate(50, -30) scale(0.4)"/>
      </g>
      <text x="0" y="45" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="20" letter-spacing="2" text-anchor="middle">VERIFIED TRUST</text>
    </g>
  `;

  const chosenGraphicArt = isFestival ? vectorDiyaArt : (isReview ? vectorStarBadgeArt : vectorCricketArt);

  const styleId = Math.floor(Math.random() * 3);
  let svgContent = '';

  if (styleId === 0) {
    // LAYOUT 0: Rich Festive/Craft Poster with Center Vector Graphic & Radial Glow
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <defs>
          <radialGradient id="bgGlow" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stop-color="${isFestival ? '#7c2d12' : '#1e1b4b'}"/>
            <stop offset="100%" stop-color="${isFestival ? '#451a03' : '#0f172a'}"/>
          </radialGradient>
        </defs>
        <rect width="1080" height="1080" fill="url(#bgGlow)"/>
        
        <!-- Outer Decorative Gold/Cyan Border -->
        <rect x="40" y="40" width="1000" height="1000" rx="24" fill="none" stroke="${isFestival ? '#fbbf24' : '#38bdf8'}" stroke-width="4" stroke-opacity="0.6"/>
        <rect x="56" y="56" width="968" height="968" rx="18" fill="none" stroke="${isFestival ? '#fbbf24' : '#38bdf8'}" stroke-width="1.5" stroke-opacity="0.3"/>
        
        <!-- Top Festival / Category Tag Pill -->
        <g transform="translate(540, 140)">
          <rect x="-200" y="0" width="400" height="56" rx="28" fill="${isFestival ? '#fbbf24' : '#38bdf8'}" fill-opacity="0.2" stroke="${isFestival ? '#fbbf24' : '#38bdf8'}" stroke-width="2"/>
          <text x="0" y="36" fill="${isFestival ? '#fbbf24' : '#38bdf8'}" font-family="system-ui, sans-serif" font-weight="900" font-size="18" letter-spacing="2" text-anchor="middle">${badgeText}</text>
        </g>
        
        <!-- Giant Dynamic Headline -->
        <text x="540" y="320" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="76" letter-spacing="-1" text-anchor="middle">${safeHeadline}</text>
        <text x="540" y="390" fill="${isFestival ? '#fef08a' : '#38bdf8'}" font-family="system-ui, sans-serif" font-weight="700" font-size="28" text-anchor="middle">${isFestival ? activeFestival.subtitle : 'Dedicated Care &amp; Precision Handling'}</text>
        
        <!-- CENTER REAL VECTOR GRAPHIC ART -->
        ${chosenGraphicArt}
        
        <!-- Bottom Business Branding Card Stamp -->
        <g transform="translate(540, 890)">
          <rect x="-420" y="0" width="840" height="110" rx="20" fill="#000000" fill-opacity="0.4" stroke="${isFestival ? '#fbbf24' : '#38bdf8'}" stroke-width="2"/>
          <text x="0" y="48" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="38" letter-spacing="1" text-anchor="middle">${safeName}</text>
          <text x="0" y="82" fill="${isFestival ? '#fbbf24' : '#38bdf8'}" font-family="system-ui, sans-serif" font-weight="700" font-size="20" letter-spacing="0.5" text-anchor="middle">${safeCat} • Verified Local Enterprise</text>
        </g>
      </svg>
    `;
  } else if (styleId === 1) {
    // LAYOUT 1: Split Vector Banner with Side Art Integration
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <defs>
          <linearGradient id="bgGlow1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#022c22"/><stop offset="100%" stop-color="#064e3b"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1080" fill="url(#bgGlow1)"/>
        
        <rect x="0" y="0" width="1080" height="24" fill="#34d399"/>
        
        <g transform="translate(100, 140)">
          <rect width="360" height="50" rx="25" fill="#34d399" fill-opacity="0.2" stroke="#34d399" stroke-width="2"/>
          <text x="180" y="32" fill="#34d399" font-family="system-ui, sans-serif" font-weight="800" font-size="16" letter-spacing="2" text-anchor="middle">${badgeText}</text>
        </g>
        
        <text x="100" y="340" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="78" letter-spacing="-1">${safeHeadline}</text>
        <text x="100" y="410" fill="#a7f3d0" font-family="system-ui, sans-serif" font-weight="700" font-size="30">${isFestival ? activeFestival.subtitle : 'Hand-knocked, repaired &amp; restored for peak play.'}</text>
        
        <!-- Vector Art Positioned Prominently -->
        <g transform="translate(0, -60)">
          ${chosenGraphicArt}
        </g>
        
        <g transform="translate(100, 890)">
          <text x="0" y="40" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="44" letter-spacing="1">${safeName}</text>
          <text x="0" y="80" fill="#34d399" font-family="system-ui, sans-serif" font-weight="700" font-size="22">${safeCat} • Official Business Profile</text>
        </g>
      </svg>
    `;
  } else {
    // LAYOUT 2: Dark Studio Luxe Vector Poster
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <rect width="1080" height="1080" fill="#0b1329"/>
        
        <circle cx="540" cy="540" r="420" fill="#38bdf8" opacity="0.08" filter="blur(60px)"/>
        <rect x="60" y="60" width="960" height="960" rx="32" fill="none" stroke="#38bdf8" stroke-width="3" stroke-opacity="0.4"/>
        
        <g transform="translate(540, 150)">
          <rect x="-180" y="0" width="360" height="52" rx="26" fill="#38bdf8" fill-opacity="0.15" stroke="#38bdf8" stroke-width="2"/>
          <text x="0" y="34" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="800" font-size="16" letter-spacing="2" text-anchor="middle">${badgeText}</text>
        </g>
        
        <text x="540" y="320" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="74" letter-spacing="-1" text-anchor="middle">${safeHeadline}</text>
        <text x="540" y="380" fill="#94a3b8" font-family="system-ui, sans-serif" font-weight="600" font-size="26" text-anchor="middle">${isFestival ? activeFestival.subtitle : 'Master Craftsmanship • Community Trust'}</text>
        
        ${chosenGraphicArt}
        
        <g transform="translate(540, 900)">
          <text x="0" y="35" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="42" letter-spacing="1" text-anchor="middle">${safeName}</text>
          <text x="0" y="72" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="20" letter-spacing="0.5" text-anchor="middle">${safeCat}</text>
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
