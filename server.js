/**
 * SJbs.AI - Production Engine (Clean Modular Architecture)
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const passport = require('passport');
const session = require('express-session');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

// Dynamic CORS configuration
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

// MongoDB Atlas Connection
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Atlas Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// Express Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'sjbs_ai_production_secret',
  resave: false,
  saveUninitialized: false
}));

// Passport Strategy Initialization
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport');

// Background Cron Workers (Auto-Reply & Auto-Post Tasks)
require('./services/workers');

// Modular API Routes
app.use('/auth', require('./routes/auth'));
app.use('/api', require('./routes/users'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/auto-posts', require('./routes/autoPosts'));
app.use('/api/notifications', require('./routes/notifications'));

// Root Health Check Route
app.get('/', (req, res) => res.send('SJbs.AI Engine Live'));

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
