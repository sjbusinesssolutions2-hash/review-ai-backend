require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json());
app.use(cors());

// Initialize AI & Payments
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Google OAuth Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

app.get('/', (req, res) => res.send('Review AI Backend is Running!'));

// Google Auth Redirect
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/business.manage']
    });
    res.redirect(url);
});

// Google OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.send("Google Business Profile Connected Successfully!");
});

// Create Razorpay Subscription
app.post('/api/create-subscription', async (req, res) => {
    try {
        const { planId, customerEmail } = req.body;
        const subscription = await razorpay.subscriptions.create({
            plan_id: planId,
            total_count: 12,
            quantity: 1,
            customer_notify: 1,
            notes: { email: customerEmail }
        });
        res.status(200).json({ subscription_id: subscription.id, key_id: process.env.RAZORPAY_KEY_ID });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Webhook for Incoming Reviews & AI Replies
app.post('/webhook/google-review', async (req, res) => {
    try {
        const { reviewText, starRating, reviewId, businessName, supportEmail } = req.body;
        const prompt = `
            You are the customer relations manager for ${businessName}.
            A customer left a review:
            - Star Rating: ${starRating} Stars
            - Review Text: "${reviewText}"

            Rules:
            1. If 4 or 5 stars: Thank them warmly in under 30 words.
            2. If 1, 2, or 3 stars: Apologize sincerely and request them to email directly at ${supportEmail}.
            3. Return ONLY the direct response text.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        const aiReply = response.text.trim();
        const mybusiness = google.mybusinessreviews({ version: 'v1', auth: oauth2Client });
        await mybusiness.accounts.locations.reviews.updateReply({
            name: reviewId,
            requestBody: { comment: aiReply }
        });

        res.status(200).json({ status: "success", reply: aiReply });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
