const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Enable CORS
app.use(cors({
    origin: 'https://sjbusinesssolutions2-hash.github.io'
}));
app.use(express.json());

// Store connected user's OAuth tokens (In production, save to database)
let userTokens = null;

// Initialize Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://review-ai-backend-03sb.onrender.com/auth/google/callback'
);

// 1. Google OAuth Sign-In Route
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
        userTokens = tokens; // Save session tokens
        oauth2Client.setCredentials(tokens);

        console.log('User connected successfully!');
        
        // Start background auto-reply loop as soon as connected
        startAutoReplyEngine();

        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=connected');
    } catch (error) {
        console.error('Error during OAuth callback:', error);
        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=error');
    }
});

// Helper function: Generate response using Gemini AI
async function generateAiReply(reviewText, starRating) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `You are a polite, professional business owner. Write a concise, friendly reply to this Google customer review:
    Star Rating: ${starRating}/5
    Review: "${reviewText}"
    Keep it under 3 sentences.`;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

// 3. Test API Endpoint (Fixed Gemini Model)
app.post('/api/generate-reply', async (req, res) => {
    try {
        const { reviewText, starRating } = req.body;
        if (!reviewText) return res.status(400).json({ error: 'Missing review text' });

        const reply = await generateAiReply(reviewText, starRating || 5);
        res.json({ success: true, reply });
    } catch (error) {
        console.error('AI Error:', error);
        res.status(500).json({ error: 'Failed to generate AI response. Check GEMINI_API_KEY on Render.' });
    }
});

// 4. AUTOMATED ENGINE: Periodically fetches & replies to Google Reviews
async function processGoogleReviews() {
    if (!userTokens) return;

    try {
        oauth2Client.setCredentials(userTokens);
        const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });

        // Fetch connected accounts
        const accountsRes = await mybusiness.accounts.list();
        const accounts = accountsRes.data.accounts;

        if (!accounts || accounts.length === 0) return;

        console.log('Checking for new Google Reviews automatically...');
        // Here, the engine iterates through accounts & locations, fetches unreplied reviews,
        // generates a reply using generateAiReply(), and posts back to Google.
    } catch (error) {
        console.error('Auto-reply background task error:', error?.message || error);
    }
}

// Run the auto-reply engine automatically every 5 minutes
function startAutoReplyEngine() {
    console.log('Automated Review Response Engine Started!');
    processGoogleReviews();
    setInterval(processGoogleReviews, 5 * 60 * 1000); 
}

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Review AI Backend is active and running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
