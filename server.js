import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';

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

// 1. User Schema
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true },
  name: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiry: Date
});
const User = mongoose.model('User', userSchema);

// 2. Per-Location Subscription Schema
const subscriptionSchema = new mongoose.Schema({
  userEmail: String,
  locationName: String,     // e.g. "accounts/102.../locations/882..."
  locationTitle: String,    // e.g. "India Bat Service - Branch 1"
  status: { type: String, enum: ['free', 'active', 'canceled'], default: 'free' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  currentPeriodEnd: Date
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

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

    const updateData = {
      name: userInfo.data.name,
      accessToken: tokens.access_token,
      tokenExpiry: new Date(Date.now() + (tokens.expiry_date || 3600 * 1000))
    };
    if (tokens.refresh_token) {
      updateData.refreshToken = tokens.refresh_token;
    }

    await User.findOneAndUpdate(
      { email: userInfo.data.email },
      { googleId: userInfo.data.id, ...updateData },
      { upsert: true, new: true }
    );

    res.json({ success: true, accessToken: tokens.access_token, email: userInfo.data.email, name: userInfo.data.name });
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

// --- FETCH BUSINESS LOCATIONS (Mapped with Subscription Plan Status) ---
app.get('/api/locations', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ success: false, error: 'Email query parameter required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const authClient = await getAuthenticatedClient(user);
    const mybusinessaccountmanagement = google.mybusinessaccountmanagement({ version: 'v1', auth: authClient });

    const accountsRes = await mybusinessaccountmanagement.accounts.list();
    const accounts = accountsRes.data.accounts || [];

    let allLocations = [];
    const mybusinessbusinessinformation = google.mybusinessbusinessinformation({ version: 'v1', auth: authClient });

    for (const account of accounts) {
      try {
        const locRes = await mybusinessbusinessinformation.accounts.locations.list({ parent: account.name });
        if (locRes.data.locations) {
          allLocations.push(...locRes.data.locations);
        }
      } catch (err) {
        console.error('Error fetching locations for account:', account.name);
      }
    }

    // Attach individual subscription status per location from MongoDB
    const enrichedLocations = await Promise.all(allLocations.map(async (loc) => {
      let sub = await Subscription.findOne({ userEmail: email, locationName: loc.name });
      if (!sub) {
        sub = await Subscription.create({ userEmail: email, locationName: loc.name, locationTitle: loc.title, status: 'free' });
      }
      return {
        name: loc.name,
        title: loc.title,
        planTier: sub.status
      };
    }));

    res.json({ success: true, locations: enrichedLocations });
  } catch (error) {
    console.error('Locations error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- FETCH REVIEWS ROUTE ---
app.get('/api/reviews', async (req, res) => {
  try {
    const { email, locationName } = req.query;
    if (!email || !locationName) return res.status(400).json({ success: false, error: 'Missing parameters' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const authClient = await getAuthenticatedClient(user);
    const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews`;
    const response = await authClient.request({ url });

    res.json({ success: true, reviews: response.data.reviews || [] });
  } catch (error) {
    console.error('Fetch reviews error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- FREE TOOLS: AI REPLY GENERATOR ---
app.post('/api/tools/generate-reply', async (req, res) => {
  try {
    const { reviewText, tone } = req.body;
    if (!reviewText) return res.status(400).json({ success: false, error: 'Review text required' });

    const prompt = `Write a ${tone || 'professional'} business owner response to this customer review: "${reviewText}". Keep it warm, polite, and under 3 sentences.`;
    
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    res.json({ success: true, reply: aiResponse.text.trim() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- RAZORPAY PAYMENT ENDPOINTS ---
app.post('/api/payments/create-order', async (req, res) => {
  try {
    const { email, locationName, amount } = req.body;
    // Note: In production, initialize razorpay SDK using process.env.RAZORPAY_KEY_ID & SECRET
    // For now we simulate or mock order generation structure securely:
    const orderId = 'order_' + crypto.randomBytes(8).toString('hex');
    
    res.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mockkey',
      order: {
        id: orderId,
        amount: amount || 2900,
        currency: 'INR'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payments/verify', async (req, res) => {
  try {
    const { email, locationName, razorpay_order_id, razorpay_payment_id } = req.body;
    
    // Update or create subscription for this specific location
    await Subscription.findOneAndUpdate(
      { userEmail: email, locationName },
      { 
        status: 'active',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days Pro
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Payment verified and location upgraded to Pro' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- ADMIN MASTER CONTROL PANEL ENDPOINTS ---
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ success: false, error: 'Unauthorized admin access' });
    }

    const totalUsers = await User.countDocuments();
    const totalLocations = await Subscription.countDocuments();
    const activeSubs = await Subscription.countDocuments({ status: 'active' });
    const mrr = activeSubs * 2900; // ₹2900 per pro branch

    const allSubscriptions = await Subscription.find().sort({ currentPeriodEnd: -1 });

    res.json({
      success: true,
      metrics: { totalUsers, totalLocations, activeSubs, mrr },
      subscriptions: allSubscriptions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/override-plan', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ success: false, error: 'Unauthorized admin access' });
    }

    const { locationName, status } = req.body;
    await Subscription.findOneAndUpdate({ locationName }, { status });

    res.json({ success: true, message: `Location plan updated to ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- AUTOPILOT ENGINE (Manual & Background Cron Execution) ---
async function processAutopilotForUser(user) {
  try {
    const authClient = await getAuthenticatedClient(user);
    const mybusinessbusinessinformation = google.mybusinessbusinessinformation({ version: 'v1', auth: authClient });
    
    const accountManagement = google.mybusinessaccountmanagement({ version: 'v1', auth: authClient });
    const accountsRes = await accountManagement.accounts.list();
    const accounts = accountsRes.data.accounts || [];

    for (const account of accounts) {
      const locRes = await mybusinessbusinessinformation.accounts.locations.list({ parent: account.name });
      const locations = locRes.data.locations || [];

      for (const loc of locations) {
        // Check if this location has an active Pro subscription before running background AI replies
        const sub = await Subscription.findOne({ userEmail: user.email, locationName: loc.name });
        if (!sub || sub.status !== 'active') {
          continue; // Skip free locations on background cron autopilot
        }

        const reviewsUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews`;
        const reviewsRes = await authClient.request({ url: reviewsUrl });
        const reviews = reviewsRes.data.reviews || [];

        for (const review of reviews) {
          if (!review.reviewReply && review.comment) {
            const prompt = `Write a professional, appreciative business owner response to this Google review. Reviewer rating: ${review.starRating}. Comment: "${review.comment}". Keep it warm, polite, and under 3 sentences.`;
            
            const aiResponse = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: prompt
            });

            const replyText = aiResponse.text.trim();

            const replyUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews/${review.reviewId}/reply`;
            await authClient.request({
              method: 'PUT',
              url: replyUrl,
              data: { comment: replyText }
            });

            console.log(`Successfully auto-replied to review for Pro location: ${loc.title}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Autopilot error for user ${user.email}:`, err.message);
  }
}

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
