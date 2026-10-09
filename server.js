const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// 1. Route to initiate Google Sign-In
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

// 2. Google OAuth Callback Route
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('Authorization code missing.');
    }

    try {
        // Exchange authorization code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        console.log('Successfully authenticated tokens:', tokens);

        // REDIRECT back to your GitHub Pages dashboard upon success
        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=connected');
    } catch (error) {
        console.error('Error during OAuth callback:', error);
        res.redirect('https://sjbusinesssolutions2-hash.github.io/review-ai-app/?status=error');
    }
});

// Health check endpoint for Render
app.get('/', (req, res) => {
    res.send('Review AI Backend is running running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
