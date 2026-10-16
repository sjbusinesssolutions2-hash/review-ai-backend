import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema for Token Persistence
const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiry: Date
});
const User = mongoose.model('User', userSchema);

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- GOOGLE OAUTH EXCHANGE ROUTE ---
app.post('/api/auth/google', async (req, res) => {
  try {
    const { code, redirectUri } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Authorization code missing' });

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    // Save tokens securely in MongoDB (preserving refresh token if already stored)
    const updateData = {
      email: userInfo.data.email,
      accessToken: tokens.access_token,
      tokenExpiry: new Date(Date.now() + (tokens.expiry_date || 3600 * 1000))
    };
    if (tokens.refresh_token) {
      updateData.refreshToken = tokens.refresh_token;
    }

    await User.findOneAndUpdate(
      { googleId: userInfo.data.id },
      updateData,
      { upsert: true, new: true }
    );

    res.json({ success: true, accessToken: tokens.access_token, email: userInfo.data.email });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- HELPER: GET AUTHENTICATED CLIENT FOR ANY USER ---
async function getAuthenticatedClient(userDoc) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: userDoc.accessToken,
    refresh_token: userDoc.refreshToken,
    expiry_date: userDoc.tokenExpiry ? userDoc.tokenExpiry.getTime() : null
  });

  // Automatically refresh token if expired
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      userDoc.accessToken = tokens.access_token;
      if (tokens.refresh_token) userDoc.refreshToken = tokens.refresh_token;
      userDoc.tokenExpiry = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);
      await userDoc.save();
    }
  });

  return oauth2Client;
}

// --- FETCH BUSINESS LOCATIONS ---
app.get('/api/locations/all', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];

    const user = await User.findOne({ accessToken: token });
    if (!user) return res.status(401).json({ error: 'Invalid session' });

    const authClient = await getAuthenticatedClient(user);
    const mybusinessaccountmanagement = google.mybusinessaccountmanagement({ version: 'v1', auth: authClient });

    const accountsRes = await mybusinessaccountmanagement.accounts.list();
    const accounts = accountsRes.data.accounts || [];

    let allLocations = [];
    const mybusinessbusinessinformation = google.mybusinessbusinessinformation({ version: 'v1', auth: authClient });

    for (const account of accounts) {
      try {
        const locRes = await mybusinessbusinessinformation.locations.list({ parent: account.name });
        if (locRes.data.locations) {
          allLocations.push(...locRes.data.locations);
        }
      } catch (err) {
        console.error('Error fetching locations for account:', account.name);
      }
    }

    res.json({ success: true, locations: allLocations });
  } catch (error) {
    console.error('Locations error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- FETCH REVIEWS ROUTE ---
app.post('/api/reviews/fetch', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];

    const user = await User.findOne({ accessToken: token });
    if (!user) return res.status(401).json({ error: 'Invalid session' });

    const { locationName } = req.body;
    const authClient = await getAuthenticatedClient(user);

    const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews`;
    const response = await authClient.request({ url });

    res.json({ success: true, reviews: response.data.reviews || [] });
  } catch (error) {
    console.error('Fetch reviews error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- AUTOPILOT ENGINE (Manual & Background Cron Execution) ---
async function processAutopilotForUser(user) {
  try {
    const authClient = await getAuthenticatedClient(user);
    const mybusinessbusinessinformation = google.mybusinessbusinessinformation({ version: 'v1', auth: authClient });
    
    // Get accounts & locations
    const accountManagement = google.mybusinessaccountmanagement({ version: 'v1', auth: authClient });
    const accountsRes = await accountManagement.accounts.list();
    const accounts = accountsRes.data.accounts || [];

    for (const account of accounts) {
      const locRes = await mybusinessbusinessinformation.locations.list({ parent: account.name });
      const locations = locRes.data.locations || [];

      for (const loc of locations) {
        const reviewsUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews`;
        const reviewsRes = await authClient.request({ url: reviewsUrl });
        const reviews = reviewsRes.data.reviews || [];

        for (const review of reviews) {
          // If review has no reply yet, generate one via Gemini AI
          if (!review.reviewReply && review.comment) {
            const prompt = `Write a professional, appreciative business owner response to this Google review. Reviewer rating: ${review.starRating}. Comment: "${review.comment}". Keep it warm, polite, and under 3 sentences.`;
            
            const aiResponse = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: prompt
            });

            const replyText = aiResponse.text().trim();

            // Post reply back to Google
            const replyUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews/${review.reviewId}/reply`;
            await authClient.request({
              method: 'PUT',
              url: replyUrl,
              data: { comment: replyText }
            });

            console.log(`Successfully auto-replied to review for location: ${loc.title}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Autopilot error for user ${user.email}:`, err.message);
  }
}

// Manual Endpoint from Dashboard
app.post('/api/reviews/autopilot', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];

    const user = await User.findOne({ accessToken: token });
    if (!user) return res.status(401).json({ error: 'Invalid session' });

    await processAutopilotForUser(user);
    res.json({ success: true, message: 'AI Autopilot sync completed successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- 24/7 BACKGROUND CRON ENDPOINT (Pung by cron-job.org) ---
app.get('/api/cron/autopilot', async (req, res) => {
  try {
    console.log('Running 24/7 background cron autopilot check...');
    const allUsers = await User.find({ refreshToken: { $exists: true } });

    for (const user of allUsers) {
      await processAutopilotForUser(user);
    }

    res.json({ success: true, message: `Cron executed for ${allUsers.length} users.` });
  } catch (error) {
    console.error('Cron job error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
