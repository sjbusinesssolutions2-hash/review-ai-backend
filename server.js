/**
 * ProsperAI - Enterprise SaaS Backend Server (server.js)
 * Stack: Node.js, Express, MongoDB Atlas, Google OAuth / Business Profile APIs
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://sjbusinesssolutions2-hash.github.io', 'http://localhost:3000'], // Update with your GitHub Pages URL if different
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'prosperai_secure_secret_key',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

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
    callbackURL: '/auth/google/callback'
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
            { locationId: 'loc_001', locationName: profile.displayName + ' Branch', isPro: false, aiCredits: 100 }
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

// --- AUTH ROUTES ---
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/business.manage'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    // Successful authentication, redirect back to frontend inbox with token
    const token = req.user._id;
    res.redirect(`https://sjbusinesssolutions2-hash.github.io/inbox.html?token=${token}&userId=${req.user._id}`);
  }
);

// --- API ROUTES ---

// 1. Get User Profile & Locations
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

// 2. AI Reply Generation Endpoint
app.post('/api/ai/reply', async (req, res) => {
  const { rating } = req.body;
  const aiReply = `Hi there! Thank you for the wonderful ${rating}-star rating. We're thrilled you enjoyed our service and look forward to serving you again soon!`;
  res.json({ reply: aiReply });
});

// 3. Health Check
app.get('/', (req, res) => {
  res.send('ProsperAI Backend Server is Live & Running!');
});

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
