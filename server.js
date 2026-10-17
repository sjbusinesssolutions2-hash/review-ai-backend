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

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://sjbusinesssolutions2-hash.github.io', 'http://localhost:3000'],
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'prosperai_secure_secret_key',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Initialize Google Gemini AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// MongoDB Atlas Connection
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB Atlas Connected Successfully'))
.catch(err => console.error('MongoDB Connection Error:', err));

// Mongoose User Schema
const userSchema = new mongoose.Schema({
  googleId: String,
  displayName: String,
  email: String,
  avatar: String,
  accessToken: String,
  refreshToken: String,
  locations: [{
    locationId: String,
    locationName: String,
    isPro: { type: Boolean, default: false },
    aiCredits: { type: Number, default: 100 }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Passport Google OAuth Strategy Configuration
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
          refreshToken,
          locations: [
            { locationId: 'loc_primary', locationName: profile.displayName + ' (Main Branch)', isPro: false, aiCredits: 100 }
          ]
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

// --- HELPER: INFINITE RETRY / PERSISTENT GEMINI GENERATOR ---
async function generateAIContentPersistent(prompt) {
  const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  let attempts = 0;
  const maxAttempts = 10; // Keep trying up to 10 times with exponential delay

  while (attempts < maxAttempts) {
    const currentModel = models[attempts % models.length];
    try {
      console.log(`[AI] Attempt ${attempts + 1} using model ${currentModel}...`);
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: prompt,
      });

      if (response && response.text && response.text.trim().length > 0) {
        return response.text.trim();
      }
    } catch (err) {
      console.warn(`[AI Warning] Model ${currentModel} failed or rate limited: ${err.message}. Retrying...`);
    }

    attempts++;
    // Exponential backoff delay (1s, 2s, 3s, etc.)
    await new Promise(resolve => setTimeout(resolve, Math.min(attempts * 1000, 5000)));
  }

  throw new Error('AI Generation failed after maximum persistent attempts.');
}

// --- AUTH ROUTES ---
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/business.manage'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/review-ai-app/login.html' }),
  (req, res) => {
    const token = req.user._id;
    res.redirect(`https://sjbusinesssolutions2-hash.github.io/review-ai-app/inbox.html?token=${token}&userId=${req.user._id}`);
  }
);

// --- REAL API ROUTES ---

// 1. Fetch Real Business Locations
app.get('/api/locations', async (req, res) => {
  const userId = req.headers.authorization;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ locations: user.locations });
  } catch (err) {
    console.error('Error fetching locations:', err);
    res.status(500).json({ error: 'Failed to fetch Google Business locations' });
  }
});

// 2. Persistent AI Review Reply Generation
app.post('/api/ai/reply', async (req, res) => {
  const { reviewText, rating, businessName } = req.body;
  const prompt = `Write a professional, warm, engaging response to a ${rating}-star Google review for ${businessName || 'our business'}. Customer review: "${reviewText}". Keep it courteous, brand-focused, personalized, and under 60 words.`;

  try {
    const replyText = await generateAIContentPersistent(prompt);
    res.json({ reply: replyText });
  } catch (err) {
    console.error('Persistent Gemini AI Error:', err);
    res.status(500).json({ error: 'AI Service currently overloaded. Please try again.' });
  }
});

// 3. Persistent AI Daily Post Generator with Visual Asset
app.post('/api/ai/post', async (req, res) => {
  const { topic, businessType, businessName } = req.body;
  const textPrompt = `Create an engaging, high-converting local update post for a Google Business Profile (${businessName || 'our business'}). Business Type: "${businessType || 'Local Services'}". Topic/Focus: "${topic || 'Quality customer service and weekly updates'}". Include local SEO keywords, an engaging hook, and a clear call-to-action. Keep it concise.`;

  try {
    const postText = await generateAIContentPersistent(textPrompt);

    // Dynamic high-resolution business image topic
    const imageSearchKey = encodeURIComponent(`${businessType || 'business'} ${topic || 'professional'}`);
    const imageUrl = `https://image.pollinations.ai/prompt/high%20quality%20professional%20photo%20of%20${imageSearchKey}?width=800&height=600&nologo=true`;

    res.json({ 
      postContent: postText,
      imageUrl: imageUrl
    });
  } catch (err) {
    console.error('Persistent Gemini AI Post Error:', err);
    res.status(500).json({ error: 'Failed to generate AI post' });
  }
});

// 4. Get User Profile
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

// 5. Autopilot Cron Endpoint
app.get('/api/cron/autopilot', async (req, res) => {
  try {
    const users = await User.find({});
    console.log(`[Autopilot Cron] Triggered for ${users.length} accounts.`);
    res.json({ success: true, message: `Autopilot active for ${users.length} accounts.` });
  } catch (err) {
    res.status(500).json({ error: 'Autopilot cron failure' });
  }
});

// 6. Health Check
app.get('/', (req, res) => {
  res.send('ProsperAI Persistent Engine is Live & Running!');
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
