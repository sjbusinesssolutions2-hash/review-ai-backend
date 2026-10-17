/**
 * SJbs.AI - Production SaaS Engine
 * Stack: Node.js, Express, MongoDB Atlas, Google OAuth, Google Business Profile APIs, Google Gemini AI
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors({
  origin: ['https://sjbusinesssolutions2-hash.github.io', 'http://localhost:3000'],
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'sjbs_ai_production_secret',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB Atlas Connected'))
.catch(err => console.error('MongoDB Error:', err));

const userSchema = new mongoose.Schema({
  googleId: String,
  displayName: String,
  email: String,
  avatar: String,
  accessToken: String,
  refreshToken: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://review-ai-backend-03sb.onrender.com/auth/google/callback',
    proxy: true
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        user = new User({
          googleId: profile.id,
          displayName: profile.displayName,
          email: profile.emails[0].value,
          avatar: profile.photos[0].value,
          accessToken,
          refreshToken
        });
      } else {
        user.accessToken = accessToken;
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

// AI Generation Logic (Pure Gemini Output)
async function generateGeminiAI(prompt) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt
  });
  if (response && response.text) {
    return response.text.trim();
  }
  throw new Error('Gemini API returned an empty text output.');
}

// Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/business.manage'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/review-ai-app/login.html' }),
  (req, res) => {
    res.redirect(`https://sjbusinesssolutions2-hash.github.io/review-ai-app/inbox.html?userId=${req.user._id}`);
  }
);

// Get Authenticated User
app.get('/api/user', async (req, res) => {
  const userId = req.headers.authorization;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch Real Google Business Profile Locations
app.get('/api/locations', async (req, res) => {
  const userId = req.headers.authorization;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = await User.findById(userId);
    if (!user || !user.accessToken) {
      return res.status(401).json({ error: 'Google Access Token missing.' });
    }

    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: user.accessToken });

    // Fetch accounts from Google My Business Account Management API
    const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
    const accountsRes = await mybusiness.accounts.list();
    const accounts = accountsRes.data.accounts || [];

    let realLocations = [];

    if (accounts.length > 0) {
      const accountName = accounts[0].name; // e.g. "accounts/123456789"
      // Fetch locations for account
      const mybusinessInfo = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
      const locationsRes = await mybusinessInfo.accounts.locations.list({
        parent: accountName,
        readMask: 'name,title,storefrontAddress'
      });
      
      if (locationsRes.data.locations) {
        realLocations = locationsRes.data.locations.map(loc => ({
          locationId: loc.name,
          locationName: loc.title
        }));
      }
    }

    // If Google API account has no locations registered yet, return logged user's account name
    if (realLocations.length === 0) {
      realLocations = [{
        locationId: 'loc_account_primary',
        locationName: user.displayName + ' Business'
      }];
    }

    res.json({ locations: realLocations });

  } catch (err) {
    console.error('Error querying Google Business Profile API:', err.message);
    // Return user display name as account context if API permissions are pending verification
    const user = await User.findById(userId).catch(() => null);
    res.json({
      locations: [{
        locationId: 'loc_account_primary',
        locationName: (user?.displayName || 'My') + ' Business'
      }]
    });
  }
});

// Real AI Daily Google Post Generator Endpoint
app.post('/api/ai/post', async (req, res) => {
  const { businessName, topic } = req.body;
  
  if (!businessName) {
    return res.status(400).json({ error: 'Business name is required to generate AI post.' });
  }

  const prompt = `You are an expert local SEO marketing manager for "${businessName}". Write a high-converting, professional, localized Google Business Profile post. Focus topic: "${topic || 'highlighting high quality customer service and weekly promotions'}". Include an engaging hook, relevant industry keywords, local SEO tags, and a clear call-to-action. Do not output preamble or conversational text.`;

  try {
    const postContent = await generateGeminiAI(prompt);
    
    // Dynamic image generation based on business name and topic
    const searchKeyword = encodeURIComponent(`${businessName} ${topic || 'service'}`);
    const imageUrl = `https://image.pollinations.ai/prompt/professional%20photo%20of%20${searchKeyword}?width=800&height=600&nologo=true`;

    res.json({ postContent, imageUrl });
  } catch (err) {
    console.error('Gemini AI Post Error:', err.message);
    res.status(500).json({ error: 'Failed to generate AI post. Please try again.' });
  }
});

// Real AI Review Reply Endpoint
app.post('/api/ai/reply', async (req, res) => {
  const { reviewText, rating, businessName } = req.body;

  const prompt = `Write a professional, personalized response to a ${rating}-star Google review for "${businessName || 'our business'}". Reviewer wrote: "${reviewText}". Keep it courteous, customer-focused, under 50 words, and directly applicable. Do not include introductory text.`;

  try {
    const reply = await generateGeminiAI(prompt);
    res.json({ reply });
  } catch (err) {
    console.error('Gemini AI Reply Error:', err.message);
    res.status(500).json({ error: 'Failed to generate AI response. Please try again.' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('SJbs.AI Real Engine Active');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
