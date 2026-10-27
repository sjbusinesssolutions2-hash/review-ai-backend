/**
 * SJbs.AI - Production Engine
 * Multi-Location GBP Sync & Pure Dynamic Concurrent AQ. Gemini AI Engine
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
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

// Dynamic CORS configuration supporting environment variable or sensible defaults
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

// Parse multiple AQ. keys from environment variable
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

// Sequential Key & Model Failover Engine for Review Replies
async function generate2LineAIReply(businessName, reviewerName, starRating, comment) {
  if (!geminiKeys || geminiKeys.length === 0) {
    console.error('[Gemini AI] No valid AQ. API keys found in environment variables.');
    return null;
  }

  const cleanComment = (comment && comment.trim() !== '') ? comment.trim() : 'Great service!';
  const cleanName = (reviewerName && reviewerName.trim() !== '') ? reviewerName.trim().split(' ')[0] : 'customer';

  const prompt = `You are replying to a Google Business review for "${businessName}" as a business owner.

Reviewer: ${cleanName}
Rating: ${starRating} Stars
Review: "${cleanComment}"

Instructions:
1. Match the exact language and script of the customer's comment (English, Roman Hindi, Roman Gujarati, etc.).
2. Write a concise, natural response (1 to 2 sentences max).
3. Do NOT follow a fixed formula or template. Speak like a genuine person writing a unique message on the spot, referencing specific details from their review.
4. Avoid repetitive sign-offs, quotes, or preambles.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          let cleanText = responseText.trim().replace(/^["']|["']$/g, '');
          const sentences = cleanText.match(/[^.!?]+[.!?]+/g);
          
          if (sentences && sentences.length >= 2) {
            return `${sentences[0].trim()} ${sentences[1].trim()}`;
          } else if (sentences && sentences.length === 1) {
            return `${sentences[0].trim()}`;
          }
          return cleanText;
        }
      } catch (err) {
        console.warn(`[Gemini AI] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  console.error('[Gemini AI] All keys and model fallbacks exhausted.');
  return null;
}

// Seasonal Festival Info Helper
function getSeasonalFestivalInfo(dateObj) {
  const month = dateObj.getMonth();
  if (month === 9 || month === 10) return "Diwali, Dhanteras, and peak festive season. Focus on festive celebrations, gear readiness, and community spirit.";
  if (month === 0) return "Uttarayan / Makar Sankranti and New Year season.";
  if (month === 2) return "Holi festival and spring tournament kickoff.";
  if (month === 7) return "Independence Day and sports training season.";
  return "Local seasonal highlights and community celebrations.";
}

// Dedicated Generator for Auto-Posts & Test Bench (Date & Festival Aware)
async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we take immense pride in delivering top-tier ${category || 'services'}. #${(locationName || 'Business').replace(/\s+/g, '')}`;
  }

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const seasonalHint = getSeasonalFestivalInfo(now);
  
  let festivalContext = "Disabled";
  if (enableFestivals) {
    festivalContext = `ENABLED for today (${currentDate}). Active Festival Context: ${seasonalHint}. Weave a warm, festive greeting naturally into the post if applicable.`;
  }

  const prompt = `You are an expert social media manager for a local business named "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
Generate an engaging Google Business Profile post based on these settings:
- Today's Date: ${currentDate}
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Festival/Holiday Greetings: ${festivalContext}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled (highlight customer satisfaction)' : 'Disabled'}

Requirements:
1. 2 to 4 sentences long.
2. Professional, engaging, and inviting tone.
3. Include 1 clear call-to-action (walk-ins or phone calls only, NO online booking) and 2 relevant hashtags.
4. Avoid repetitive formulas or rigid templates.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {}
    }
  }

  return `Visit us today for great service and special offers! #LocalBusiness #CustomerFirst`;
}

// Pure AI-Driven Dynamic SVG Banner Generator (Zero Hardcoded Fallbacks)
async function generateAiPosterSvg(locationName, category, topics, enableFestivals) {
  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  let headline = topics && topics.trim().length > 3 ? topics.trim() : `Expert ${bCat}`;
  if (headline.length > 50) headline = headline.substring(0, 47) + '...';

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const seasonalHint = getSeasonalFestivalInfo(now);
  
  const festivalInstruction = enableFestivals 
    ? `FESTIVAL THEME ACTIVE: Feature the upcoming season/festival (${seasonalHint}) with tasteful celebratory accents.` 
    : `Standard professional spotlight banner.`;

  // 10+ Diverse, High-End Editorial Color Palettes
  const palettes = [
    { name: "Vintage Cream & Terracotta", bg: "#faf8f5", card: "#f2eae1", text: "#1c1917", accent: "#ea580c", border: "#e7e5e4" },
    { name: "Festive Saffron & Gold", bg: "#fffbeb", card: "#fef3c7", text: "#451a03", accent: "#d97706", border: "#fde68a" },
    { name: "Deep Forest & Mint", bg: "#f0fdf4", card: "#dcfce7", text: "#052e16", accent: "#16a34a", border: "#bbf7d0" },
    { name: "Midnight Navy & Sky", bg: "#f8fafc", card: "#e2e8f0", text: "#0f172a", accent: "#0284c7", border: "#cbd5e1" },
    { name: "Rich Burgundy & Rose", bg: "#fff1f2", card: "#ffe4e6", text: "#4c0519", accent: "#e11d48", border: "#fecdd3" },
    { name: "Warm Terracotta & Clay", bg: "#fdf8f6", card: "#faedcd", text: "#381d05", accent: "#bc6c25", border: "#e6ccb2" },
    { name: "Emerald Luxe", bg: "#ecfdf5", card: "#a7f3d0", text: "#022c22", accent: "#059669", border: "#6ee7b7" },
    { name: "Royal Indigo", bg: "#eef2ff", card: "#e0e7ff", text: "#1e1b4b", accent: "#4f46e5", border: "#c7d2fe" },
    { name: "Sunset Amber", bg: "#fff7ed", card: "#ffedd5", text: "#431407", accent: "#ea580c", border: "#fed7aa" },
    { name: "Charcoal Minimalist", bg: "#f8fafc", card: "#e2e8f0", text: "#18181b", accent: "#52525b", border: "#d4d4d8" }
  ];

  const selectedPalette = palettes[Math.floor(Math.random() * palettes.length)];

  const prompt = `You are an elite graphic designer creating a unique, high-end 1080x1080 square vector banner SVG for "${bName}" (${bCat}).
Headline: "${headline}".
${festivalInstruction}

DESIGN & COLOR DIRECTIVE:
1. Return ONLY valid SVG code (<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">...</svg>) without markdown formatting or backticks.
2. COLOR SCHEME TO USE FOR THIS POST: Use the "${selectedPalette.name}" theme:
   - Background Fill: ${selectedPalette.bg}
   - Card/Container Fill: ${selectedPalette.card}
   - Primary Text Color: ${selectedPalette.text}
   - Accent / Highlight Color: ${selectedPalette.accent}
   - Border / Line Color: ${selectedPalette.border}
3. Layout & Typography: Clean editorial layout, beautiful spacing, professional hierarchy, vector graphics relevant to ${bCat}.
4. Restrictions: NO customer reviews or star ratings in the graphic. Truthful workshop messaging only ("Walk-Ins Welcome • Direct Service").
5. XML Safety: All tags properly closed, zero duplicate attributes.`;

  if (geminiKeys && geminiKeys.length > 0) {
    for (let k = 0; k < geminiKeys.length; k++) {
      const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
      try {
        const response = await aiClient.models.generateContent({ model: 'gemini-3.5-flash', contents: prompt });
        let svg = response.text || '';
        svg = svg.replace(/```xml/g, '').replace(/```svg/g, '').replace(/```/g, '').trim();
        svg = svg.replace(/class="([^"]*)"\s+class="[^"]*"/g, 'class="$1"');

        if (svg.startsWith('<svg') && svg.endsWith('</svg>')) {
          return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
        }
      } catch (err) {}
    }
  }

  throw new Error('AI Banner generation failed.');
}


// 1. Get Auto-Post Configuration for a Business
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

// 2. Update Auto-Post Preferences
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

// 3. Get Scheduled & Post History
app.get('/api/auto-posts/history/:businessId', async (req, res) => {
  try {
    res.json({ success: true, posts: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Upgraded Test Generate Route using independent text and banner generators
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

    let postPrompt = topics;
    if (realReviewSnippet && reviewerName) {
      postPrompt = `Highlighting 5-star review from ${reviewerName}: "${realReviewSnippet}". ${topics || ''}`;
    }

    const postText = await generateAutoPostText(bName, bCat, postPrompt, enableFestivals, enableReviewSpotlights);
    const imageUrl = await generateAiPosterSvg(bName, bCat, topics, enableFestivals);

    res.json({
      success: true,
      postText: postText,
      imageUrl: imageUrl,
      reviewerUsed: reviewerName || null,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Error in upgraded test-generate route:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


async function fetchLocationReviews(accessToken, accountName, locationName) {
  try {
    let parentPath = locationName;
    if (!locationName.startsWith('accounts/')) {
      parentPath = `${accountName}/${locationName}`;
    }

    const res = await fetch(`[https://mybusiness.googleapis.com/v4/$](https://mybusiness.googleapis.com/v4/$){parentPath}/reviews`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const reviews = data.reviews || [];
      const count = data.totalReviewCount || reviews.length;
      let rating = data.averageRating || 5.0;

      if (reviews.length > 0 && !data.averageRating) {
        const totalStars = reviews.reduce((acc, r) => {
          const val = r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1;
          return acc + val;
        }, 0);
        rating = totalStars / reviews.length;
      }

      return {
        reviews,
        reviewCount: count,
        rating: parseFloat(rating.toFixed(1)),
        parentPath
      };
    }
  } catch (err) {
    console.warn(`Fetch reviews notice for ${locationName}:`, err.message);
  }
  return { reviews: [], reviewCount: 0, rating: 5.0, parentPath: locationName };
}

// 24/7 Automated Background Auto-Reply Worker for Pro Businesses
cron.schedule('*/15 * * * *', async () => {
  console.log('[Auto-Reply Worker] Running periodic check for unanswered reviews across Pro locations...');
  try {
    const users = await User.find({ 'locations.subscriptionStatus': 'pro', 'locations.autoReplyEnabled': true });

    for (const user of users) {
      if (!user.accessToken) continue;

      for (const loc of user.locations) {
        if (loc.subscriptionStatus !== 'pro' || !loc.autoReplyEnabled) continue;

        const parentPath = loc.accountLocationPath || loc.locationId;
        const reviewData = await fetchLocationReviews(user.accessToken, parentPath.split('/')[0] + '/' + parentPath.split('/')[1], parentPath);
        const unreplied = (reviewData.reviews || []).filter(r => !r.reviewReply);

        for (const review of unreplied) {
          const reviewerName = review.reviewer && review.reviewer.displayName ? review.reviewer.displayName : 'Customer';
          const starVal = review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 : review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1;
          
          const replyText = await generate2LineAIReply(loc.locationName, reviewerName, starVal, review.comment || '');

          if (replyText) {
            const googleRes = await fetch(`[https://mybusiness.googleapis.com/v4/$](https://mybusiness.googleapis.com/v4/$){parentPath}/reviews/${review.reviewId}/reply`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ comment: replyText })
            });

            if (googleRes.ok) {
              console.log(`[Auto-Reply Worker] Successfully replied automatically for location: ${loc.locationName}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Reply Worker] Error executing background worker:', err.message);
  }
});

app.get('/auth/google', passport.authenticate('google', {
  scope: [
    'profile',
    'email',
    'https://www.googleapis.com/auth/business.manage'
  ],
  accessType: 'offline',
  prompt: 'consent'
}));

const frontendBaseUrl = process.env.FRONTEND_URL || '[https://sjbusinesssolutions2-hash.github.io/review-ai-app](https://sjbusinesssolutions2-hash.github.io/review-ai-app)';

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: `${frontendBaseUrl}/login.html` }),
  async (req, res) => {
    try {
      const user = req.user;
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: user.accessToken });

      const mybusinessaccountmanagement = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
      const accountsRes = await mybusinessaccountmanagement.accounts.list();
      const accounts = accountsRes.data.accounts || [];

      for (const acc of accounts) {
        try {
          const mybusinessinfo = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
          const locsRes = await mybusinessinfo.accounts.locations.list({
            parent: acc.name,
            readMask: 'name,title,storefrontAddress'
          });

          if (locsRes.data.locations) {
            for (const [idx, loc] of locsRes.data.locations.entries()) {
              const reviewData = await fetchLocationReviews(user.accessToken, acc.name, loc.name);
              const addressStr = loc.storefrontAddress && loc.storefrontAddress.addressLines ? loc.storefrontAddress.addressLines.join(', ') : '';

              const existingLocIndex = user.locations.findIndex(l => l.locationId === loc.name);

              if (existingLocIndex !== -1) {
                user.locations[existingLocIndex].locationName = loc.title;
                user.locations[existingLocIndex].accountLocationPath = reviewData.parentPath;
                user.locations[existingLocIndex].rating = reviewData.rating;
                user.locations[existingLocIndex].reviewCount = reviewData.reviewCount;
                user.locations[existingLocIndex].address = addressStr;
              } else {
                user.locations.push({
                  locationId: loc.name,
                  accountLocationPath: reviewData.parentPath,
                  locationName: loc.title,
                  rating: reviewData.rating,
                  reviewCount: reviewData.reviewCount,
                  address: addressStr,
                  subscriptionStatus: user.locations.length === 0 ? 'pro' : 'free',
                  autoReplyEnabled: true
                });
              }
            }
          }
        } catch (e) {
          console.warn('Location listing notice:', e.message);
        }
      }

      await user.save();

      const userName = encodeURIComponent(user.displayName || 'User');
      const userEmail = encodeURIComponent(user.email || '');

      res.redirect(`${frontendBaseUrl}/inbox.html?userId=${user._id}&userName=${userName}&userEmail=${userEmail}`);
    } catch (err) {
      console.error('OAuth Callback Error:', err);
      res.redirect(`${frontendBaseUrl}/inbox.html?userId=${req.user._id}&userName=${encodeURIComponent(req.user.displayName || 'User')}`);
    }
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
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

// Supporting both /api/user and /api/user/me for absolute client compatibility
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

    const formattedBusinesses = [];

    for (const [idx, loc] of (user.locations || []).entries()) {
      let liveCount = loc.reviewCount || 0;
      let liveRating = loc.rating || 5.0;

      if (user.accessToken && loc.accountLocationPath) {
        const parts = loc.accountLocationPath.split('/');
        const accountName = parts.slice(0, 2).join('/');
        const locationName = parts.slice(2).join('/');
        const liveData = await fetchLocationReviews(user.accessToken, accountName, locationName);
        if (liveData.reviewCount > 0) {
          liveCount = liveData.reviewCount;
          liveRating = liveData.rating;
        }
      }

      formattedBusinesses.push({
        id: loc.locationId,
        name: loc.locationName,
        rating: liveRating.toFixed(1),
        reviewCount: liveCount,
        address: loc.address || '',
        subscriptionStatus: loc.subscriptionStatus || 'free'
      });
    }

    res.json(formattedBusinesses);
  } catch (err) {
    console.error('Error fetching businesses:', err.message);
    res.status(500).json({ error: 'Server error fetching businesses' });
  }
});

app.get('/api/reviews/all', async (req, res) => {
  const { userId, businessId } = req.query;

  if (!userId || !businessId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'User or access token not found' });
    }

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const targetBusinessName = targetLocation ? targetLocation.locationName : 'Our Business';
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;
    const isPro = targetLocation && targetLocation.subscriptionStatus === 'pro';

    let rawReviews = [];

    try {
      const response = await fetch(`[https://mybusiness.googleapis.com/v4/$](https://mybusiness.googleapis.com/v4/$){parentPath}/reviews`, {
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const fetchedReviews = data.reviews || [];

        rawReviews = fetchedReviews.map(r => ({
          reviewId: r.reviewId,
          reviewerName: (r.reviewer && r.reviewer.displayName) ? r.reviewer.displayName : 'Google User',
          starRating: r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1,
          comment: r.comment || '',
          reply: r.reviewReply ? r.reviewReply.comment : null,
          updateTime: r.updateTime || ''
        }));
      }
    } catch (err) {
      console.warn('[API /reviews/all] Reviews Google API fetch error:', err.message);
    }

    let userModified = false;
    let freeRepliesCount = user.freeRepliesUsed || 0;

    const processedReviews = await Promise.all(
      rawReviews.map(async (item) => {
        let aiDraftReply = '';

        if (!item.reply) {
          let existingDraft = user.savedDrafts.find(d => d.reviewId === item.reviewId);

          if (existingDraft && existingDraft.draftText) {
            aiDraftReply = existingDraft.draftText;
          } else {
            let canGenerate = isPro || freeRepliesCount < 2;

            if (canGenerate) {
              const generated = await generate2LineAIReply(
                targetBusinessName,
                item.reviewerName,
                item.starRating,
                item.comment
              );

              if (generated) {
                aiDraftReply = generated;
                user.savedDrafts.push({
                  reviewId: item.reviewId,
                  draftText: aiDraftReply
                });
                userModified = true;

                if (!isPro) {
                  freeRepliesCount++;
                  user.freeRepliesUsed = freeRepliesCount;
                }
              }
            }
          }
        }

        return {
          ...item,
          aiDraftReply
        };
      })
    );

    if (userModified) {
      await user.save();
    }

    const needsReplyCount = processedReviews.filter(r => !r.reply).length;
    const repliedCount = processedReviews.filter(r => r.reply).length;

    res.json({
      reviews: processedReviews,
      counts: {
        needsYou: needsReplyCount,
        all: processedReviews.length,
        replied: repliedCount
      },
      isPro,
      freeRepliesUsed: freeRepliesCount
    });
  } catch (err) {
    console.error('[API /reviews/all] CRITICAL ERROR:', err.message);
    res.status(500).json({ error: 'Server error fetching reviews' });
  }
});

app.post('/api/reviews/dismiss', async (req, res) => {
  const { userId, reviewId } = req.body;
  if (!userId || !reviewId) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.savedDrafts = user.savedDrafts.filter(d => d.reviewId !== reviewId);
    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error dismissing task' });
  }
});

app.post('/api/reviews/reply', async (req, res) => {
  const { userId, businessId, reviewId, replyText } = req.body;

  if (!userId || !businessId ||Id || !reviewId || !replyText || replyText.trim() === '') {
    return res.status(400).json({ error: 'Missing required parameters or empty reply text' });
  }

  try {
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'Unauthorized user access' });
    }

    const targetLocation = (user.locations || []).find(l => l.locationId === businessId);
    const parentPath = targetLocation && targetLocation.accountLocationPath ? targetLocation.accountLocationPath : businessId;

    const googleRes = await fetch(`[https://mybusiness.googleapis.com/v4/$](https://mybusiness.googleapis.com/v4/$){parentPath}/reviews/${reviewId}/reply`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${user.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: replyText })
    });

    if (googleRes.ok) {
      const responseData = await googleRes.json();
      user.savedDrafts = user.savedDrafts.filter(d => d.reviewId !== reviewId);
      await user.save();

      return res.json({ success: true, reply: responseData });
    } else {
      const errorText = await googleRes.text();
      return res.status(googleRes.status).json({ error: 'Failed to post reply to Google Business Profile' });
    }
  } catch (err) {
    console.error('Error posting review reply:', err.message);
    res.status(500).json({ error: 'Server error updating review reply' });
  }
});

// Admin Panel APIs
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-accessToken -refreshToken');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users list' });
  }
});

app.post('/api/admin/update-subscription', async (req, res) => {
  let { userId, locationId, subscriptionStatus } = req.body;

  if (!userId || !locationId || !subscriptionStatus) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const rawLocId = decodeURIComponent(locationId);

    const result = await User.updateOne(
      { _id: userId, 'locations.locationId': rawLocId },
      { $set: { 'locations.$.subscriptionStatus': subscriptionStatus } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'User or Location not found' });
    }

    res.json({ success: true, message: `Updated location status to ${subscriptionStatus}` });
  } catch (err) {
    console.error('Update subscription error:', err);
    res.status(500).json({ success: false, error: 'Server error updating subscription' });
  }
});

app.post('/api/admin/reset-free-limit', async (req, res) => {
  const { userId } = req.body;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.freeRepliesUsed = 0;
    user.savedDrafts = [];
    await user.save();

    res.json({ success: true, message: 'Reset free usage counter' });
  } catch (err) {
    res.status(500).json({ error: 'Server error resetting limit' });
  }
});

app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
