const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB database'))
    .catch(err => console.error('MongoDB connection error:', err));

// Define User Schema for storing tokens
const UserSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true },
    tokens: { type: Object, required: true }
});
const User = mongoose.model('User', UserSchema);

// Enable CORS
app.use(cors({
    origin: 'https://sjbusinesssolutions2-hash.github.io'
}));
app.use(express.json());

// Initialize Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://review-ai-backend-03sb.onrender.com/auth/google/callback'
);

// 1. Initiate Google Sign-In
app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/business.manage'
    ];

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: scopes
    });

    res.redirect(url);
});

// 2. Google OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('Authorization code missing.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Fetch user info to store against googleId
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        // Save or update user tokens in MongoDB
        await User.findOneAndUpdate(
            { googleId: userInfo.data.id },
            { tokens: tokens },
            { upsert: true, new: true }
        );

        console.log(`User ${userInfo.data.email} connected and tokens saved to database.`);

        // Run an immediate check for reviews
        processGoogleReviews();

        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=connected');
    } catch (error) {
        console.error('Error during OAuth callback:', error);
        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=error');
    }
});

// Helper function: Generate AI review response
async function generateAiReply(reviewText, starRating) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `You are a polite, professional business owner. Write a concise, warm reply to this Google review:
    Star Rating: ${starRating}/5
    Review: "${reviewText}"
    Keep response brief, appreciative, and under 3 sentences.`;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

// 3. AUTOMATED ENGINE: Fetch unreplied reviews for ALL connected users in DB
async function processGoogleReviews() {
    try {
        const users = await User.find();
        if (!users || users.length === 0) return;

        for (const user of users) {
            oauth2Client.setCredentials(user.tokens);
            const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });

            const accountsRes = await mybusiness.accounts.list();
            const accounts = accountsRes.data.accounts;

            if (!accounts || accounts.length === 0) continue;

            for (const account of accounts) {
                const mybusinessInfo = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
                const locationsRes = await mybusinessInfo.accounts.locations.list({
                    parent: account.name,
                    readMask: 'name,title'
                });

                const locations = locationsRes.data.locations || [];

                for (const loc of locations) {
                    const reviewsUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews`;
                    const reviewsRes = await oauth2Client.request({ url: reviewsUrl });
                    const reviews = reviewsRes.data.reviews || [];

                    for (const review of reviews) {
                        if (!review.reviewReply) {
                            const reviewText = review.comment || "No text provided (Star Rating only)";
                            const numericRating = review.starRating === 'FIVE' ? 5 :
                                                  review.starRating === 'FOUR' ? 4 :
                                                  review.starRating === 'THREE' ? 3 :
                                                  review.starRating === 'TWO' ? 2 : 1;

                            const aiReply = await generateAiReply(reviewText, numericRating);

                            await oauth2Client.request({
                                url: `${reviewsUrl}/${review.reviewId}/reply`,
                                method: 'PUT',
                                data: { comment: aiReply }
                            });

                            console.log(`Successfully replied to review ${review.reviewId}`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in background review engine:', error?.response?.data || error.message);
    }
}

// Run review automation every 5 minutes
setInterval(processGoogleReviews, 5 * 60 * 1000);

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Review AI Backend is active and running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
