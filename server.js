const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(cors());

process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

const MONGO_URI = process.env.MONGO_URI || '';
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB Atlas database'))
    .catch(err => console.error('MongoDB connection error:', err));
}

const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, required: true },
  email: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiry: Date,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 1. Google OAuth Token Exchange Endpoint
app.post('/api/auth/google', async (req, res) => {
  try {
    const { code, redirectUri } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Authorization code missing' });

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri || 'https://sjbusinesssolutions2-hash.github.io/review-ai-app/',
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) return res.status(400).json({ success: false, error: tokenData.error_description || tokenData.error });

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    await User.findOneAndUpdate(
      { googleId: profile.id },
      {
        email: profile.email,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || undefined,
        tokenExpiry: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000)
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, accessToken: tokenData.access_token, email: profile.email });
  } catch (error) {
    console.error('Server error in /api/auth/google:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch ALL Associated Google Business Accounts & Locations
app.get('/api/locations/all', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];

    const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const accountsData = await accountsRes.json();
    const accounts = accountsData.accounts || [];

    let allLocations = [];

    for (const account of accounts) {
      const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const locData = await locRes.json();
      if (locData.locations) {
        locData.locations.forEach(loc => {
          // loc.name is usually "locations/xxxxxx". We combine it with account.name ("accounts/yyyyyy")
          const fullResourceName = `${account.name}/${loc.name}`;
          allLocations.push({
            name: fullResourceName,
            title: loc.title || 'Google Business Location'
          });
        });
      }
    }

    // Fallback search if account iteration yields nothing
    if (allLocations.length === 0) {
      const fallbackRes = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations?readMask=name,title', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const fallbackData = await fallbackRes.json();
      if (fallbackData.locations) {
        fallbackData.locations.forEach(loc => {
          allLocations.push({
            name: loc.name.startsWith('accounts/') ? loc.name : `accounts/-/${loc.name}`,
            title: loc.title || 'Google Business Location'
          });
        });
      }
    }

    res.json({ success: true, locations: allLocations });
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper: Scan multiple potential v4 path variations to guarantee review retrieval
async function fetchReviewsRobust(locationPath, accessToken) {
  // Clean up path variations to try
  const cleanLoc = locationPath.replace('accounts/-/', '').replace('accounts/', '');
  // Extract just the location ID if nested
  const locationId = cleanLoc.includes('/') ? cleanLoc.split('/').pop() : cleanLoc;

  // Build possible paths to query against Google v4 endpoint
  const candidatePaths = [
    locationPath,
    `accounts/-/${locationPath.replace('accounts/-/', '')}`,
    `accounts/-/locations/${locationId}`
  ];

  // Also extract account ID if present
  if (locationPath.includes('accounts/')) {
    const parts = locationPath.split('/');
    const accIdx = parts.indexOf('accounts');
    if (accIdx !== -1 && parts[accIdx + 1]) {
      const accId = parts[accIdx + 1];
      candidatePaths.push(`accounts/${accId}/locations/${locationId}`);
    }
  }

  // Deduplicate candidate paths
  const uniquePaths = [...new Set(candidatePaths)];

  for (const path of uniquePaths) {
    try {
      const targetUrl = `https://mybusiness.googleapis.com/v4/${path}/reviews`;
      console.log(`Querying reviews at: ${targetUrl}`);
      const response = await fetch(targetUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await response.json();
      if (data.reviews && data.reviews.length > 0) {
        console.log(`Successfully found ${data.reviews.length} reviews using path: ${path}`);
        return data.reviews;
      }
    } catch (err) {
      console.log(`Path ${path} failed:`, err.message);
    }
  }
  return [];
}

// 3. Fetch Real Reviews Endpoint
app.post('/api/reviews/fetch', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];
    const { locationName } = req.body;

    if (!locationName) {
      return res.status(400).json({ success: false, error: 'Location name is required' });
    }

    const reviews = await fetchReviewsRobust(locationName, accessToken);
    res.json({ success: true, reviews });
  } catch (error) {
    console.error('Fetch reviews error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Robust Gemini AI Generator
async function generateGeminiReply(prompt, apiKey) {
  const models = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        const aiData = await aiRes.json();
        if (aiData.candidates && aiData.candidates[0]?.content?.parts?.[0]?.text) {
          return aiData.candidates[0].content.parts[0].text.trim();
        }

        if (aiData.error && (aiData.error.code === 503 || aiData.error.code === 429)) {
          await new Promise(resolve => setTimeout(resolve, 4000));
        } else {
          break;
        }
      } catch (err) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  return null;
}

// 4. Autopilot Route
app.post('/api/reviews/autopilot', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];
    const { locationName } = req.body;

    const reviews = await fetchReviewsRobust(locationName, accessToken);

    if (reviews.length === 0) {
      return res.json({ success: true, message: 'No live reviews found for this location.', activityLog: [] });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY missing in environment.' });

    let processedCount = 0;
    const activityLog = [];

    for (const review of reviews) {
      const reviewText = review.comment || 'Great service!';
      const starRating = review.starRating || 'FIVE';
      const reviewerName = review.reviewer?.displayName || 'Valued Customer';

      if (review.reviewReply) {
        activityLog.push({
          reviewer: reviewerName,
          rating: starRating,
          comment: reviewText,
          reply: review.reviewReply.comment,
          status: 'Already Replied'
        });
        continue;
      }

      const prompt = `Write a professional, warm, and highly personalized business reply to this customer review.
      Customer Name: ${reviewerName}
      Star Rating: ${starRating}
      Review Text: "${reviewText}"

      Rules:
      1. Directly reference specific details mentioned in the customer's comment.
      2. Do NOT use generic sentences like "Thank you for your feedback!".
      3. Keep response to 2-3 sentences.`;

      let replyText = await generateGeminiReply(prompt, apiKey);
      if (!replyText) replyText = `ERROR: Gemini API busy or key invalid.`;

      // Post Reply to Google Review API
      await fetch(`https://mybusiness.googleapis.com/v4/${review.name}/reply`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ comment: replyText })
      });

      processedCount++;
      activityLog.push({
        reviewer: reviewerName,
        rating: starRating,
        comment: reviewText,
        reply: replyText,
        status: 'Newly Replied'
      });
    }

    res.json({ 
      success: true, 
      message: `Autopilot complete! Replied to ${processedCount} pending review(s).`,
      activityLog 
    });
  } catch (error) {
    console.error('Autopilot error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
