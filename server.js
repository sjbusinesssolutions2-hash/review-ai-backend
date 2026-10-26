/**
 * SJbs.AI - Production Engine
 * Multi-Location GBP Sync & Pure Dynamic Concurrent AQ. Gemini AI Engine
 * Photorealistic FLUX.1 Engine + Dynamic SVG Banner Fail-Safe
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

// Fixed Hugging Face call using Axios to solve `fetch failed`
async function tryHuggingFaceFlux(promptText, retries = 2, delayMs = 3000) {
  const hfKey = process.env.HUGGINGFACE_API_KEY;
  if (!hfKey) {
    throw new Error('HUGGINGFACE_API_KEY environment variable is not configured.');
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await axios.post(
        "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
        { inputs: promptText },
        {
          headers: {
            Authorization: `Bearer ${hfKey}`,
            "Content-Type": "application/json",
            "User-Agent": "SJBS-AI-Engine/1.0"
          },
          responseType: "arraybuffer",
          timeout: 25000
        }
      );

      if (response.status === 200) {
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
        return `data:image/jpeg;base64,${base64Image}`;
      }
    } catch (err) {
      const status = err.response ? err.response.status : null;
      console.warn(`[Image Engine] HF Attempt ${attempt} failed (${status || err.message})...`);

      if (status === 429 || status === 401) {
        throw new Error(`HF Permanent Error (${status})`);
      }

      if (attempt <= retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

// Dynamic Multi-Theme SVG Banner Generator with Dynamic Colors
function generateDynamicSvgBanner(businessName, category) {
  const safeName = (businessName || 'Our Business').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeCat = (category || 'Professional Services').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const themes = [
    { bg1: '#0f172a', bg2: '#1e293b', accent: '#38bdf8', glow: '#0284c7' },
    { bg1: '#111827', bg2: '#1f2937', accent: '#10b981', glow: '#059669' },
    { bg1: '#1e1b4b', bg2: '#312e81', accent: '#818cf8', glow: '#4f46e5' },
    { bg1: '#2e1065', bg2: '#3b0764', accent: '#c084fc', glow: '#7e22ce' }
  ];

  const selectedTheme = themes[Math.floor(Math.random() * themes.length)];

  const svgContent = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
      <defs>
        <linearGradient id="dynamicBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${selectedTheme.bg1}"/>
          <stop offset="100%" stop-color="${selectedTheme.bg2}"/>
        </linearGradient>
        <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#000000" flood-opacity="0.5"/>
        </filter>
      </defs>
      
      <rect width="800" height="600" fill="url(#dynamicBg)"/>
      <circle cx="700" cy="100" r="220" fill="${selectedTheme.glow}" opacity="0.15" filter="blur(40px)"/>
      <circle cx="100" cy="500" r="240" fill="${selectedTheme.accent}" opacity="0.1" filter="blur(50px)"/>
      
      <g filter="url(#shadow)">
        <rect x="70" y="160" width="660" height="280" rx="24" fill="${selectedTheme.bg1}" fill-opacity="0.85" stroke="${selectedTheme.accent}" stroke-width="2" stroke-opacity="0.4"/>
      </g>
      
      <rect x="340" y="210" width="120" height="32" rx="16" fill="${selectedTheme.glow}" fill-opacity="0.25" stroke="${selectedTheme.accent}" stroke-opacity="0.5" stroke-width="1"/>
      <text x="400" y="231" text-anchor="middle" fill="${selectedTheme.accent}" font-family="system-ui, sans-serif" font-weight="600" font-size="12" letter-spacing="1.5">VERIFIED</text>
      
      <text x="400" y="295" text-anchor="middle" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="38" letter-spacing="0.5">
        ${safeName}
      </text>
      
      <text x="400" y="340" text-anchor="middle" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-weight="500" font-size="18" letter-spacing="0.5">
        ${safeCat}
      </text>
    </svg>
  `.trim();

  const base64Svg = Buffer.from(svgContent).toString('base64');
  return `data:image/svg+xml;base64,${base64Svg}`;
}

async function generatePostImageWithFallback(imagePrompt, businessName, category) {
  try {
    console.log('[Image Engine] Attempting Primary Engine (Hugging Face FLUX.1 via Axios)...');
    return await tryHuggingFaceFlux(imagePrompt);
  } catch (hfError) {
    console.warn('[Image Engine] HF Engine failed. Generating Dynamic SVG Fail-safe:', hfError.message);
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ success: false, error: 'Server error' });
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
    res.status(500).json({ error: 'Server error fetching reviews' });
  }
});

app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
