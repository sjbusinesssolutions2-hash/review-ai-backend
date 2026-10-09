const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Enable CORS for frontend
app.use(cors({
    origin: 'https://sjbusinesssolutions2-hash.github.io'
}));
app.use(express.json());

// In-memory token storage (In production, replace with MongoDB or Supabase)
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
        userTokens = tokens; // Save active user tokens
        oauth2Client.setCredentials(tokens);

        console.log('User connected successfully!');
        
        // Trigger initial check immediately upon connection
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

// 3. COMPLETE AUTOMATED ENGINE: Fetch unreplied reviews & post AI replies to Google
async function processGoogleReviews() {
    if (!userTokens) {
        console.log('No connected account tokens found. Skipping auto-reply check.');
        return;
    }

    try {
        oauth2Client.setCredentials(userTokens);
        const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });

        // Step A: Fetch connected Google Business accounts
        const accountsRes = await mybusiness.accounts.list();
        const accounts = accountsRes.data.accounts;

        if (!accounts || accounts.length === 0) {
            console.log('No Google Business accounts found for this user.');
            return;
        }

        console.log(`Checking ${accounts.length} business account(s) for unreplied reviews...`);

        for (const account of accounts) {
            // Step B: Fetch locations under the business account
            const mybusinessInfo = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
            const locationsRes = await mybusinessInfo.accounts.locations.list({
                parent: account.name,
                readMask: 'name,title'
            });

            const locations = locationsRes.data.locations || [];

            for (const loc of locations) {
                // Step C: Fetch reviews via My Business API
                const reviewsUrl = `https://mybusiness.googleapis.com/v4/${loc.name}/reviews`;
                const reviewsRes = await oauth2Client.request({ url: reviewsUrl });
                const reviews = reviewsRes.data.reviews || [];

                for (const review of reviews) {
                    // Step D: Check if review has no reply yet
                    if (!review.reviewReply) {
                        const reviewText = review.comment || "No text provided (Star Rating only)";
                        const numericRating = review.starRating === 'FIVE' ? 5 :
                                              review.starRating === 'FOUR' ? 4 :
                                              review.starRating === 'THREE' ? 3 :
                                              review.starRating === 'TWO' ? 2 : 1;

                        console.log(`New unreplied review found: "${reviewText}" (${numericRating} stars)`);

                        // Step E: Generate AI response
                        const aiReply = await generateAiReply(reviewText, numericRating);

                        // Step F: Post reply back to Google
                        await oauth2Client.request({
                            url: `${reviewsUrl}/${review.reviewId}/reply`,
                            method: 'PUT',
                            data: { comment: aiReply }
                        });

                        console.log(`Successfully posted AI reply to review ID: ${review.reviewId}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error during Google Reviews processing:', error?.response?.data || error.message);
    }
}

// Run auto-reply engine every 5 minutes
setInterval(processGoogleReviews, 5 * 60 * 1000);

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Review AI Backend is active and running!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
