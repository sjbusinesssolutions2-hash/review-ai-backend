/**
 * SJbs.AI - Production GBP Automation Engine
 * Real Social Media Poster SVG Engine with Live Upcoming Indian Festivals
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

// Live Indian Festival Calendar (November - December 2026)
function getCurrentOrUpcomingFestival() {
  const now = new Date();
  const month = now.getMonth(); // 10 is November, 11 is December
  const day = now.getDate();

  if (month === 10) { // November 2026
    if (day >= 6 && day <= 12) return { name: "Diwali 2026 (Festival of Lights)", tag: "✨ HAPPY DIWALI" };
    if (day >= 22 && day <= 26) return { name: "Guru Nanak Jayanti / Kartik Purnima", tag: "🪔 GURPURAB GREETINGS" };
  } else if (month === 11) { // December 2026
    if (day >= 12 && day <= 16) return { name: "Vivah Panchami", tag: "🌟 VIVAH PANCHAMI" };
    if (day >= 18 && day <= 22) return { name: "Gita Jayanti", tag: "📜 GITA JAYANTI" };
  }
  return { name: "Festive Season Celebration", tag: "✨ FESTIVE CELEBRATION" };
}

async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  const activeFestival = getCurrentOrUpcomingFestival();
  const festivalPromptContext = enableFestivals 
    ? `Current/Upcoming Real Festival to incorporate naturally: ${activeFestival.name}.` 
    : 'No specific festival required unless prompted.';

  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we take pride in delivering exceptional ${category || 'services'} for our local community. ${enableFestivals ? `Wishing everyone a blessed ${activeFestival.name}!` : 'Visit our workshop today!'} #${(locationName || 'Business').replace(/\s+/g, '')} #${(category || 'Service').replace(/\s+/g, '')}`;
  }

  const prompt = `You are an expert social media writer creating an authentic Google Business Profile post for "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).

Post Focus & Settings:
- Business Focus / Topics: ${topics || 'Highlighting our core expertise and craftsmanship'}
- Seasonal Greetings: ${enableFestivals ? `ENABLED (${festivalPromptContext})` : 'DISABLED'}
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

// TRUE SOCIAL MEDIA POST GRAPHIC GENERATOR (Dynamic, Edge-to-Edge Poster Style with Real Festivals)
function generateSocialMediaPostSvg(businessName, category, postText, topicInput, enableFestivals, enableReviewSpotlights) {
  const safeName = (businessName || 'Our Business').toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const activeFestival = getCurrentOrUpcomingFestival();
  let isFestival = enableFestivals || postText.toLowerCase().includes('festiv') || postText.toLowerCase().includes('diwali') || postText.toLowerCase().includes('guru nanak') || postText.toLowerCase().includes('season');
  let isReview = enableReviewSpotlights || postText.toLowerCase().includes('review') || postText.toLowerCase().includes('star');

  let headline = topicInput && topicInput.trim().length > 3 ? topicInput : "";
  if (!headline) {
    if (isFestival) headline = activeFestival.name;
    else if (isReview) headline = "Loved by Our Community";
    else headline = `Master ${safeCat} Expertise`;
  }
  if (headline.length > 34) headline = headline.substring(0, 31) + "...";
  const safeHeadline = headline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let badgeText = activeFestival.tag;
  if (isReview) badgeText = "⭐⭐⭐⭐⭐ 5-STAR TRUST";
  else if (!isFestival) badgeText = "⚡ FEATURED POST";

  const styleId = Math.floor(Math.random() * 4);
  let svgContent = '';

  if (styleId === 0) {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <defs>
          <linearGradient id="bg0" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e1b4b"/>
          </linearGradient>
          <linearGradient id="acc0" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1080" fill="url(#bg0)"/>
        <circle cx="900" cy="180" r="320" fill="#38bdf8" opacity="0.12" filter="blur(70px)"/>
        <polygon points="0,850 500,1080 0,1080" fill="#6366f1" opacity="0.2"/>
        <rect x="0" y="0" width="1080" height="24" fill="url(#acc0)"/>
        <g transform="translate(100, 140)">
          <rect width="340" height="48" rx="24" fill="#38bdf8" fill-opacity="0.15" stroke="#38bdf8" stroke-width="2"/>
          <text x="170" y="30" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="800" font-size="15" letter-spacing="1.5" text-anchor="middle">${badgeText}</text>
        </g>
        <text x="100" y="360" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="72" letter-spacing="-2">
          <tspan x="100" dy="0">${safeHeadline}</tspan>
        </text>
        <rect x="100" y="580" width="880" height="4" rx="2" fill="#38bdf8" opacity="0.4"/>
        <rect x="100" y="640" width="880" height="160" rx="20" fill="#ffffff" fill-opacity="0.05" stroke="#38bdf8" stroke-width="1.5" stroke-opacity="0.3"/>
        <text x="140" y="710" fill="#cbd5e1" font-family="system-ui, sans-serif" font-weight="600" font-size="28">“Delivering absolute precision &amp; dedication</text>
        <text x="140" y="755" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="26">for our incredible community every single day.”</text>
        <g transform="translate(100, 880)">
          <text x="0" y="40" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="42" letter-spacing="1">${safeName}</text>
          <text x="0" y="80" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="22" letter-spacing="0.5">${safeCat} • Verified Google Business</text>
        </g>
      </svg>
    `;
  } else if (styleId === 1) {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <defs>
          <linearGradient id="bg1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#451a03"/><stop offset="50%" stop-color="#78350f"/><stop offset="100%" stop-color="#7c2d12"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1080" fill="url(#bg1)"/>
        <circle cx="200" cy="200" r="260" fill="#fbbf24" opacity="0.25" filter="blur(80px)"/>
        <circle cx="900" cy="900" r="300" fill="#fde047" opacity="0.15" filter="blur(90px)"/>
        <rect x="50" y="50" width="980" height="980" rx="16" fill="none" stroke="#fbbf24" stroke-width="3" stroke-opacity="0.5"/>
        <g transform="translate(120, 140)">
          <rect width="360" height="52" rx="26" fill="#fbbf24" fill-opacity="0.2" stroke="#fbbf24" stroke-width="2"/>
          <text x="180" y="33" fill="#fbbf24" font-family="system-ui, sans-serif" font-weight="800" font-size="15" letter-spacing="1.5" text-anchor="middle">${badgeText}</text>
        </g>
        <text x="120" y="380" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="74" letter-spacing="-1">
          <tspan x="120" dy="0">${safeHeadline}</tspan>
        </text>
        <rect x="120" y="620" width="840" height="4" rx="2" fill="#fbbf24" opacity="0.6"/>
        <text x="120" y="700" fill="#fef3c7" font-family="system-ui, sans-serif" font-weight="600" font-size="30">Wishing our wonderful community peace,</text>
        <text x="120" y="745" fill="#fef3c7" font-family="system-ui, sans-serif" font-weight="600" font-size="30">prosperity, and success in every endeavor!</text>
        <g transform="translate(120, 890)">
          <text x="0" y="35" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="44" letter-spacing="1">${safeName}</text>
          <text x="0" y="75" fill="#fbbf24" font-family="system-ui, sans-serif" font-weight="700" font-size="22" letter-spacing="1">${safeCat} • Professional Local Workshop</text>
        </g>
      </svg>
    `;
  } else if (styleId === 2) {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <defs>
          <linearGradient id="bg2" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#090d16"/><stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1080" fill="url(#bg2)"/>
        <rect x="80" y="80" width="920" height="920" rx="32" fill="#0b1329" stroke="#38bdf8" stroke-width="3" stroke-opacity="0.4"/>
        <g transform="translate(140, 160)">
          <rect width="320" height="48" rx="24" fill="#38bdf8" fill-opacity="0.15" stroke="#38bdf8" stroke-width="2"/>
          <text x="160" y="30" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="800" font-size="15" letter-spacing="1.5" text-anchor="middle">${badgeText}</text>
        </g>
        <text x="140" y="380" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="70" letter-spacing="-1">
          <tspan x="140" dy="0">${safeHeadline}</tspan>
        </text>
        <line x1="140" y1="540" x2="480" y2="540" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
        <text x="140" y="630" fill="#94a3b8" font-family="system-ui, sans-serif" font-weight="600" font-size="28">“Unmatched craftsmanship and dedication</text>
        <text x="140" y="675" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="28">in every single service and interaction.”</text>
        <g transform="translate(140, 840)">
          <text x="0" y="35" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="40" letter-spacing="1">${safeName}</text>
          <text x="0" y="75" fill="#38bdf8" font-family="system-ui, sans-serif" font-weight="700" font-size="22" letter-spacing="0.5">${safeCat} • Verified Business</text>
        </g>
      </svg>
    `;
  } else {
    svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
        <defs>
          <linearGradient id="bg3" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#022c22"/><stop offset="50%" stop-color="#064e3b"/><stop offset="100%" stop-color="#047857"/>
          </linearGradient>
        </defs>
        <rect width="1080" height="1080" fill="url(#bg3)"/>
        <circle cx="900" cy="180" r="300" fill="#34d399" opacity="0.18" filter="blur(80px)"/>
        <g transform="translate(100, 140)">
          <rect width="320" height="48" rx="24" fill="#34d399" fill-opacity="0.2" stroke="#34d399" stroke-width="2"/>
          <text x="160" y="30" fill="#34d399" font-family="system-ui, sans-serif" font-weight="800" font-size="15" letter-spacing="1.5" text-anchor="middle">${badgeText}</text>
        </g>
        <text x="100" y="360" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="72" letter-spacing="-1">
          <tspan x="100" dy="0">${safeHeadline}</tspan>
        </text>
        <rect x="100" y="580" width="880" height="4" rx="2" fill="#34d399" opacity="0.5"/>
        <g transform="translate(100, 680)">
          <rect width="880" height="180" rx="20" fill="#065f46" fill-opacity="0.5" stroke="#34d399" stroke-width="2" stroke-opacity="0.4"/>
          <text x="50" y="65" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="900" font-size="40" letter-spacing="1">${safeName}</text>
          <text x="50" y="115" fill="#34d399" font-family="system-ui, sans-serif" font-weight="700" font-size="24" letter-spacing="0.5">${safeCat} • Expert Local Services</text>
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
    const finalImageUrl = generateSocialMediaPostSvg(bName, bCat, postText, topics, enableFestivals, showReviewSpotlight);

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
