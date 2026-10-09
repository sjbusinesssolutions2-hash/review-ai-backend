const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Enable CORS for frontend requests
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

        console.log('Successfully authenticated tokens:', tokens);
        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=connected');
    } catch (error) {
        console.error('Error during OAuth callback:', error);
        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=error');
    }
});

// 3. AI Endpoint to Generate Review Replies
app.post('/api/generate-reply', async (req, res) => {
    try {
        const { reviewText, starRating } = req.body;

        if (!reviewText || !starRating) {
            return res.status(400).json({ error: 'Missing reviewText or starRating' });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `You are a polite, professional business owner. Write a concise reply to this customer review.
        Star Rating: ${starRating}/5 stars
        Review: "${reviewText}"
        Keep the response brief, friendly, and appreciative.`;

        const result = await model.generateContent(prompt);
        const replyText = result.response.text();

        res.json({ success: true, reply: replyText });
    } catch (error) {
        console.error('AI Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate AI response' });
    }
});

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Review AI Backend is running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
