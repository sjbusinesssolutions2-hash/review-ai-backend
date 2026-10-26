/**
 * SJbs.AI - Production GBP Automation Engine
 * Real Business Posts (No Fake Offers) + Dynamic Festival SVG Graphic Engine
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

// 1. Organic Business Post Generator (Strictly NO invented offers/discounts)
async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we are dedicated to providing top-quality ${category || 'services'} to our community. Stop by today or contact us for more details! #${(locationName || 'Business').replace(/\s+/g, '')} #${(category || 'Service').replace(/\s+/g, '')}`;
  }

  const userHasSpecifiedOffer = topics && (
    topics.toLowerCase().includes('offer') ||
    topics.toLowerCase().includes('discount') ||
    topics.toLowerCase().includes('sale') ||
    topics.toLowerCase().includes('deal') ||
    topics.toLowerCase().includes('% off')
  );

  const prompt = `You are an expert social media writer creating an authentic Google Business Profile post for "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).

Post Focus & Settings:
- Business Specialty / Focus: ${topics || 'Highlighting our core expertise and craftsmanship'}
- Seasonal Greetings: ${enableFestivals ? 'ENABLED (Include warm festive wishes for upcoming holidays/celebrations)' : 'DISABLED'}
- Review Spotlight: ${enableReviewSpotlights ? 'ENABLED (Reflect real customer trust and 5-star feedback)' : 'DISABLED'}

STRICT RULES:
1. NEVER mention sales, discounts, special offers, prices, or freebies UNLESS explicitly written in the user topics above. Speak naturally about services, expertise, dedication, or holiday greetings.
2. Write 2 to 3 natural, engaging sentences.
3. ALWAYS include 2-3 UNIQUE, highly relevant hashtags derived SPECIFICALLY from the business niche (e.g., #CricketBatRepair #KnockInExpert #CricketLife for a cricket workshop).
4. Do NOT use generic hashtags like #LocalBusiness or #CustomerFirst.`;

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
        console.warn(`[Gemini AI] Model ${model} failed, trying next...`);
      }
    }
  }

  return `At ${locationName || 'our business'}, we take pride in delivering exceptional ${category || 'services'} for our local clients. Visit our location today! #${(locationName || 'Business').replace(/\s+/g, '')} #${(category || 'Service').replace(/\s+/g, '')}`;
}

// 2. Dynamic SVG Generator with Festival & Business Themes (No fake offers)
function generateContextualSvgBanner(businessName, category, postText, topicInput, enableFestivals) {
  const safeName = (businessName || 'Our Business').toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Determine Festival / Holiday context if enabled
  let isFestivalPost = enableFestivals || postText.toLowerCase().includes('festiv') || postText.toLowerCase().includes('season') || postText.toLowerCase().includes('diwali') || postText.toLowerCase().includes('holiday') || postText.toLowerCase().includes('wishing');
  
  let highlightBadge = "EXPERTISE & QUALITY";
  let mainHeadline = topicInput || category || "Professional Excellence";

  if (isFestivalPost) {
    highlightBadge = "✨ FESTIVE SEASON GREETINGS";
    if (!topicInput) mainHeadline = "Happy Festival Season!";
  } else if (enableReviewSpotlights || postText.toLowerCase().includes('review') || postText.toLowerCase().includes('star')) {
    highlightBadge = "⭐ 5-STAR CUSTOMER TRUST";
  }

  if (mainHeadline.length > 34) {
    mainHeadline = mainHeadline.substring(0, 31) + "...";
  }
  const safeHeadline = mainHeadline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Define Aesthetic Color Palettes (Including Festive Themes)
  const festivalPalette = { 
    bg1: '#3b0764', bg2: '#7e22ce', accent: '#fbbf24', text: '#ffffff', 
    badgeBg: 'rgba(251, 191, 36, 0.2)', glow1: '#f59e0b', glow2: '#ec4899',
    pattern: 'festive'
  };

  const standardPalettes = [
    { bg1: '#0f172a', bg2: '#0284c7', accent: '#38bdf8', text: '#ffffff', badgeBg: 'rgba(56, 189, 248, 0.15)', glow1: '#0284c7', glow2: '#38bdf8' },
    { bg1: '#064e3b', bg2: '#047857', accent: '#34d399', text: '#ffffff', badgeBg: 'rgba(52, 211, 153, 0.15)', glow1: '#059669', glow2: '#34d399' },
    { bg1: '#1e1b4b', bg2: '#3730a3', accent: '#a5b4fc', text: '#ffffff', badgeBg: 'rgba(165, 180, 252, 0.15)', glow1: '#4f46e5', glow2: '#818cf8' },
    { bg1: '#4c0519', bg2: '#9f1239', accent: '#fda4af', text: '#ffffff', badgeBg: 'rgba(253, 164, 175, 0.15)', glow1: '#e11d48', glow2: '#fb7185' }
  ];

  const theme = isFestivalPost ? festivalPalette : standardPalettes[(safeName.length + safeHeadline.length) % standardPalettes.length];

  // Festive decorative stars/sparkles overlay
  let festivalDecorations = '';
  if (isFestivalPost) {
    festivalDecorations = `
      <!-- Festive Sparkles & Lights -->
      <g fill="${theme.accent}" opacity="0.6">
        <polygon points="200,100 205,115 220,120 205,125 200,140 195,125 180,120 195,115" />
        <polygon points="1000,140 1004,152 1016,156 1004,160 1000,172 996,160 984,156 996,152" />
        <polygon points="950,480 954,492 966,496 954,500 950,512 946,500 934,496 946,492" />
        <circle cx="250" cy="500" r="4" />
        <circle cx="980" cy="220" r="6" fill="#f43f5e" />
        <circle cx="150" cy="220" r="5" fill="#38bdf8" />
      </g>
    `;
  }

  const svgContent = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${theme.bg1}"/>
          <stop offset="100%" stop-color="${theme.bg2}"/>
        </linearGradient>
        <linearGradient id="cardGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02"/>
        </linearGradient>
        <filter id="dropShadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#000000" flood-opacity="0.45"/>
        </filter>
      </defs>

      <!-- Background Canvas -->
      <rect width="1200" height="630" fill="url(#bgGradient)"/>

      <!-- Ambient Glow Orbs -->
      <circle cx="1100" cy="80" r="340" fill="${theme.glow1}" opacity="0.18" filter="blur(60px)"/>
      <circle cx="100" cy="550" r="300" fill="${theme.glow2}" opacity="0.12" filter="blur(50px)"/>

      ${festivalDecorations}

      <!-- Main Content Card Container -->
      <g filter="url(#dropShadow)">
        <rect x="80" y="80" width="1040" height="470" rx="24" fill="url(#cardGradient)" stroke="${theme.accent}" stroke-width="2" stroke-opacity="0.4"/>
      </g>

      <!-- Top Category/Festival Badge -->
      <rect x="130" y="135" width="${highlightBadge.length * 12 + 44}" height="42" rx="21" fill="${theme.badgeBg}" stroke="${theme.accent}" stroke-width="1.5"/>
      <text x="152" y="162" fill="${theme.accent}" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="14" letter-spacing="1.5">
        ${highlightBadge}
      </text>

      <!-- Main Headline / Topic Text -->
      <text x="130" y="265" fill="${theme.text}" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="44" letter-spacing="-0.5">
        ${safeHeadline}
      </text>

      <!-- Accent Divider Line -->
      <line x1="130" y1="315" x2="430" y2="315" stroke="${theme.accent}" stroke-width="4" stroke-linecap="round" opacity="0.85"/>

      <!-- Business Branding Block -->
      <g transform="translate(130, 410)">
        <text x="0" y="30" fill="${theme.text}" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="34" letter-spacing="1">
          ${safeName}
        </text>
        <text x="0" y="62" fill="${theme.accent}" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="18" letter-spacing="0.5" opacity="0.95">
          ${safeCat} • Official Google Business Profile
        </text>
      </g>
    </svg>
  `.trim();

  const base64Svg = Buffer.from(svgContent).toString('base64');
  return `data:image/svg+xml;base64,${base64Svg}`;
}

// 3. API Route for Test Generation
app.post('/api/auto-posts/test-generate', async (req, res) => {
  try {
    const { userId, businessId, locationName, category, topics, enableFestivals, enableReviewSpotlights } = req.body;

    const bName = locationName || 'Our Business';
    const bCat = category || 'Local Business';

    // Generate Tailored Post Copy with Custom Hashtags (Strictly NO invented offers)
    const postText = await generateAutoPostText(bName, bCat, topics, enableFestivals, enableReviewSpotlights);

    // Generate Dynamic SVG Asset featuring Festival Themes when enabled
    const finalImageUrl = generateContextualSvgBanner(bName, bCat, postText, topics, enableFestivals);

    res.json({
      success: true,
      postText: postText,
      imageUrl: finalImageUrl,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Error generating post preview:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// App configuration & server startup
app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));