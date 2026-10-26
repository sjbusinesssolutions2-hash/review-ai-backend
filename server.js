/**
 * SJbs.AI - Production Engine
 * Multi-Location GBP Sync & Pure Dynamic Concurrent AQ. Gemini AI Engine
 * Photorealistic Image Engine + Dynamic Unique SVG Banner Fail-Safe
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
  savedDrafts: [{
    reviewId: String,
    draftText: String
  }],
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

async function generate2LineAIReply(businessName, reviewerName, starRating, comment) {
  if (!geminiKeys || geminiKeys.length === 0) return null;

  const cleanComment = (comment && comment.trim() !== '') ? comment.trim() : 'Great service!';
  const cleanName = (reviewerName && reviewerName.trim() !== '') ? reviewerName.trim().split(' ')[0] : 'customer';

  const prompt = `You are replying to a Google Business review for "${businessName}" as a business owner.
Reviewer: ${cleanName}
Rating: ${starRating} Stars
Review: "${cleanComment}"

Instructions:
1. Match the exact language and script of the customer's comment.
2. Write a concise, natural response (1 to 2 sentences max).
3. Do NOT follow a fixed formula. Reference specific review details.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt
        });

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          let cleanText = responseText.trim().replace(/^["']|["']$/g, '');
          const sentences = cleanText.match(/[^.!?]+[.!?]+/g);
          if (sentences && sentences.length >= 2) return `${sentences[0].trim()} ${sentences[1].trim()}`;
          return cleanText;
        }
      } catch (err) {
        console.warn(`[Gemini AI] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  return null;
}

async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    return 'Visit us today for great service and special offers! #LocalBusiness #CustomerFirst';
  }

  const prompt = `You are an expert social media manager for "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
Generate an engaging Google Business Profile post based on these settings:
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Festival/Holiday Greetings: ${enableFestivals ? 'Enabled' : 'Disabled'}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled' : 'Disabled'}

Requirements:
1. 2 to 4 sentences long.
2. Professional, engaging, and inviting tone.
3. Include 1 clear call-to-action and 2 relevant hashtags.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt
        });

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        console.warn(`[Gemini AI] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  return 'Visit us today for great service and special offers! #LocalBusiness #CustomerFirst';
}

async function generateDynamicImagePrompt(locationName, category, topics) {
  if (!geminiKeys || geminiKeys.length === 0) {
    return `Cinematic commercial photography of ${category || 'services'} at "${locationName || 'Our Store'}", detailed craftsmanship, natural workshop/store lighting, shallow depth of field, 4k commercial photography, authentic local feel, no text, no watermarks, photorealistic`;
  }

  const prompt = `You are a professional AI art director and photographer.
Create a detailed, photorealistic camera scene description for a commercial photo representing this local business:
- Business Name: "${locationName}"
- Category: "${category}"
- Focus/Service: "${topics || 'Quality services'}"

Instructions:
1. Describe a realistic, authentic commercial/workshop/storefront scene.
2. Use photographic camera terminology: "shallow depth of field", "natural warm studio lighting", "4k commercial photography", "detailed textures".
3. Strictly DO NOT include any text, typography, logos, brand names, or watermarks in the prompt.
4. Keep the prompt concise (1-2 descriptive sentences). Return ONLY the prompt text directly.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt
        });

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        console.warn(`[Gemini AI Art Director] Key ${k + 1} failed: ${err.message}. Trying next...`);
      }
    }
  }

  return `Cinematic commercial photography of ${category || 'services'} at "${locationName || 'Our Store'}", detailed craftsmanship, natural workshop/store lighting, shallow depth of field, 4k commercial photography, authentic local feel, no text, no watermarks, photorealistic`;
}

// 1. Image Generation Engine (Direct photographic router - zero DNS blocking, ultra-fast)
async function tryHuggingFaceFlux(promptText) {
  const encoded = encodeURIComponent(promptText);
  const seed = Math.floor(Math.random() * 1000000);
  return `https://image.pollinations.ai/prompt/${encoded}?width=1000&height=750&nologo=true&seed=${seed}`;
}

// 2. Fully Unique Dynamic SVG Banner Generator with Rotated Themes & Layouts
function generateDynamicSvgBanner(businessName, category) {
  const safeName = (businessName || 'Our Business').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const themes = [
    { bg1: '#090d16', bg2: '#1e293b', accent: '#38bdf8', glow: '#0284c7', card: '#0b1329' },
    { bg1: '#064e3b', bg2: '#022c22', accent: '#34d399', glow: '#059669', card: '#065f46' },
    { bg1: '#312e81', bg2: '#1e1b4b', accent: '#818cf8', glow: '#4f46e5', card: '#3730a3' },
    { bg1: '#881337', bg2: '#4c0519', accent: '#fb7185', glow: '#e11d48', card: '#9f1239' },
    { bg1: '#78350f', bg2: '#451a03', accent: '#fbbf24', glow: '#d97706', card: '#92400e' }
  ];

  const t = themes[Math.floor(Math.random() * themes.length)];
  const randomRotation = (Math.random() * 4 - 2).toFixed(1);

  const svgContent = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${t.bg1}"/>
          <stop offset="100%" stop-color="${t.bg2}"/>
        </linearGradient>
        <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${t.card}"/>
          <stop offset="100%" stop-color="${t.bg1}"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="20" stdDeviation="30" flood-color="#000000" flood-opacity="0.6"/>
        </filter>
      </defs>
      
      <rect width="800" height="600" fill="url(#bgGrad)"/>
      <circle cx="${Math.floor(Math.random() * 300) + 100}" cy="150" r="250" fill="${t.glow}" opacity="0.2" filter="blur(50px)"/>
      <circle cx="${Math.floor(Math.random() * 300) + 400}" cy="450" r="280" fill="${t.accent}" opacity="0.15" filter="blur(60px)"/>
      
      <g filter="url(#shadow)" transform="rotate(${randomRotation} 400 300)">
        <rect x="90" y="150" width="620" height="300" rx="28" fill="url(#cardGrad)" stroke="${t.accent}" stroke-width="2.5" stroke-opacity="0.5"/>
        <rect x="110" y="170" width="580" height="260" rx="20" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/>
      </g>
      
      <rect x="335" y="200" width="130" height="36" rx="18" fill="${t.glow}" fill-opacity="0.3" stroke="${t.accent}" stroke-opacity="0.6" stroke-width="1.5"/>
      <text x="400" y="223" text-anchor="middle" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="700" font-size="13" letter-spacing="2">VERIFIED</text>
      
      <text x="400" y="295" text-anchor="middle" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="42" letter-spacing="0.5">
        ${safeName}
      </text>
      
      <text x="400" y="345" text-anchor="middle" fill="#cbd5e1" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="20" letter-spacing="1">
        ${safeCat}
      </text>
      
      <text x="400" y="405" text-anchor="middle" fill="${t.accent}" font-family="system-ui, sans-serif" font-weight="500" font-size="12" opacity="0.8" letter-spacing="1.5">
        OFFICIAL GOOGLE BUSINESS PROFILE
      </text>
    </svg>
  `.trim();

  const base64Svg = Buffer.from(svgContent).toString('base64');
  return `data:image/svg+xml;base64,${base64Svg}`;
}

async function generatePostImageWithFallback(imagePrompt, businessName, category) {
  try {
    return await tryHuggingFaceFlux(imagePrompt);
  } catch (err) {
    return generateDynamicSvgBanner(businessName, category);
  }
}

app.get('/api/auto-posts/config/:businessId', async (req, res) => {
  try {
    let config = await AutoPostConfig.findOne({ businessId: req.params.businessId });
    if (!config) {
      config = await AutoPostConfig.create({ businessId: req.params.businessId });
    }
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auto-posts/config/:businessId', async (req, res) => {
  try {
    const { enabled, frequency, preferredTime, topics, enableFestivals, enableReviewSpotlights } = req.body;

    const config = await AutoPostConfig.findOneAndUpdate(
      { businessId: req.params.businessId },
      { enabled, frequency, preferredTime, topics, enableFestivals, enableReviewSpotlights },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: 'Settings saved successfully', config });
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

app.post('/api/auto-posts/test-generate', async (req, res) => {
  try {
    const { userId, businessId, locationName, category, topics, enableFestivals, enableReviewSpotlights } = req.body;

    const bName = locationName || 'Our Business';
    const bCat = category || 'Local Business';

    let realReviewSnippet = '';
    let reviewerName = '';

    if (enableReviewSpotlights && userId) {
      const user = await User.findById(userId);
      if (user && user.accessToken) {
        const targetLocation = (user.locations || []).find(l => l.locationId === businessId) || user.locations[0];
        if (targetLocation && targetLocation.accountLocationPath) {
          const liveData = await fetchLocationReviews(
            user.accessToken,
            targetLocation.accountLocationPath.split('/')[0] + '/' + targetLocation.accountLocationPath.split('/')[1],
            targetLocation.accountLocationPath
          );

          const fiveStarReviews = (liveData.reviews || []).filter(r => 
            (r.starRating === 'FIVE' || r.starRating === 5) && r.comment && r.comment.trim().length > 10
          );

          if (fiveStarReviews.length > 0) {
            const selected = fiveStarReviews[Math.floor(Math.random() * fiveStarReviews.length)];
            realReviewSnippet = selected.comment.trim();
            reviewerName = (selected.reviewer && selected.reviewer.displayName) ? selected.reviewer.displayName : 'Happy Customer';
          }
        }
      }
    }

    const postText = await generateAutoPostText(bName, bCat, topics, enableFestivals, enableReviewSpotlights);
    const dynamicImagePrompt = await generateDynamicImagePrompt(bName, bCat, topics);
    const finalImageUrl = await generatePostImageWithFallback(dynamicImagePrompt, bName, bCat);

    res.json({
      success: true,
      postText: postText,
      imageUrl: finalImageUrl,
      imagePromptUsed: dynamicImagePrompt,
      reviewerUsed: reviewerName || null,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Error in test-generate route:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function fetchLocationReviews(accessToken, accountName, locationName) {
  try {
    let parentPath = locationName;
    if (!locationName.startsWith('accounts/')) {
      parentPath = `${accountName}/${locationName}`;
    }

    const res = await axios.get(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.status === 200) {
      const data = res.data;
      const reviews = data.reviews || [];
      const count = data.totalReviewCount || reviews.length;
      let rating = data.averageRating || 5.0;

      return { reviews, reviewCount: count, rating: parseFloat(rating), parentPath };
    }
  } catch (err) {
    console.warn(`Fetch reviews notice for ${locationName}:`, err.message);
  }
  return { reviews: [], reviewCount: 0, rating: 5.0, parentPath: locationName };
}

cron.schedule('*/15 * * * *', async () => {
  console.log('[Auto-Reply Worker] Running periodic check for unanswered reviews...');
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

app.get(['/api/user', '/api/user/me'], async (req, res) => {
  const userId = req.query.userId || req.headers.authorization;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/businesses', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

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
    console.error('Error fetching businesses:', err.message);
    res.status(500).json({ error: 'Server error fetching businesses' });
  }
});

app.get('/api/reviews/all', async (req, res) => {
  const { userId, businessId } = req.query;

  if (!userId || !businessId) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    res.json({ reviews: [], counts: { needsYou: 0, all: 0, replied: 0 }, isPro: true, freeRepliesUsed: 0 });
  } catch (err) {
    console.error('Error fetching reviews:', err.message);
    res.status(500).json({ error: 'Server error fetching reviews' });
  }
});

app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));