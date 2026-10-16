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

// User Schema
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true },
  name: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiry: Date
});
const User = mongoose.model('User', userSchema);

// Per-Location Subscription Schema
const subscriptionSchema = new mongoose.Schema({
  userEmail: String,
  locationName: String,
  locationTitle: String,
  status: { type: String, enum: ['free', 'active', 'canceled'], default: 'free' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  currentPeriodEnd: Date
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- GOOGLE OAUTH DIRECT ROUTES ---
const getOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL || 'https://review-ai-backend-03sb.onrender.com/auth/google/callback'
  );
};

app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/business.manage'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/index.html?error=no_code');

    const oauth2Client = getOAuthClient();
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

    const frontendUrl = process.env.FRONTEND_URL || 'https://your-username.github.io/your-repo';
    res.redirect(`${frontendUrl}/dashboard.html?email=${encodeURIComponent(userInfo.data.email)}&name=${encodeURIComponent(userInfo.data.name || '')}`);
  } catch (error) {
    console.error('OAuth Callback Error:', error);
    res.redirect('/index.html?error=auth_failed');
  }
});

// --- HELPER: GET AUTH CLIENT ---
async function getAuthenticatedClient(userDoc) {
  const oauth2Client = getOAuthClient();
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

// --- FETCH BUSINESS LOCATIONS ---
app.get('/api/locations', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });

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
        console.error('Error fetching locations:', err.message);
      }
    }

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

// --- FETCH REVIEWS ---
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

// --- FREE TOOLS ---
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

// --- PAYMENTS ---
app.post('/api/payments/create-order', async (req, res) => {
  try {
    const { email, locationName, amount } = req.body;
    const orderId = 'order_' + crypto.randomBytes(8).toString('hex');
    res.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mockkey',
      order: { id: orderId, amount: amount || 2900, currency: 'INR' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payments/verify', async (req, res) => {
  try {
    const { email, locationName, razorpay_order_id, razorpay_payment_id } = req.body;
    await Subscription.findOneAndUpdate(
      { userEmail: email, locationName },
      { 
        status: 'active',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- ADMIN ---
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const totalUsers = await User.countDocuments();
    const totalLocations = await Subscription.countDocuments();
    const activeSubs = await Subscription.countDocuments({ status: 'active' });
    const mrr = activeSubs * 2900;
    const allSubscriptions = await Subscription.find().sort({ currentPeriodEnd: -1 });

    res.json({ success: true, metrics: { totalUsers, totalLocations, activeSubs, mrr }, subscriptions: allSubscriptions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/override-plan', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const { locationName, status } = req.body;
    await Subscription.findOneAndUpdate({ locationName }, { status });
    res.json({ success: true, message: `Updated to ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- CRON AUTOPILOT ---
app.get('/api/cron/autopilot', async (req, res) => {
  try {
    const allUsers = await User.find({ refreshToken: { $exists: true } });
    for (const user of allUsers) {
      try {
        const authClient = await getAuthenticatedClient(user);
        const accountManagement = google.mybusinessaccountmanagement({ version: 'v1', auth: authClient });
        const accountsRes = await accountManagement.accounts.list();
        const accounts = accountsRes.data.accounts || [];

        for (const account of accounts) {
          const mybusinessbusinessinformation = google.mybusinessbusinessinformation({ version: 'v1', auth: authClient });
          const locRes = await mybusinessbusinessinformation.accounts.locations.list({ parent: account.name });
          const locations = locRes.data.locations || [];

          for (const loc of locations) {
            const sub = await Subscription.findOne({ userEmail: user.email, locationName: loc.name });
            if (!sub || sub.status !== 'active') continue;

            const reviewsUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews`;
            const reviewsRes = await authClient.request({ url: reviewsUrl });
            const reviews = reviewsRes.data.reviews || [];

            for (const review of reviews) {
              if (!review.reviewReply && review.comment) {
                const prompt = `Write a professional, appreciative business owner response to this Google review. Reviewer rating: ${review.starRating}. Comment: "${review.comment}". Keep it warm, polite, and under 3 sentences.`;
                const aiResponse = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
                const replyText = aiResponse.text.trim();

                const replyUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews/${review.reviewId}/reply`;
                await authClient.request({ method: 'PUT', url: replyUrl, data: { comment: replyText } });
              }
            }
          }
        }
      } catch (err) {
        console.error(`Cron error for user ${user.email}:`, err.message);
      }
    }
    res.json({ success: true, message: 'Cron executed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
