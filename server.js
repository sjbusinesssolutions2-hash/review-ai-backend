const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Global Error Catching for Debugging
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// Connect to MongoDB Database
const MONGO_URI = process.env.MONGO_URI || '';
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB database'))
    .catch(err => console.error('MongoDB connection error:', err));
} else {
  console.log('No MongoDB URI provided, running without database connection.');
}

// 1. Fetch Location ID Route
// Updated Fetch Location ID Route (Filters for verified locations)
app.get('/api/locations', async (req, res) => {
  try {
    const accessToken = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
    if (!accessToken) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }

    const accountRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const accountData = await accountRes.json();
    if (!accountData.accounts || accountData.accounts.length === 0) {
      return res.status(404).json({ success: false, error: 'No accounts found' });
    }
    const accountName = accountData.accounts[0].name;

    const locationRes = await fetch(`https://mybusinessinformation.googleapis.com/v1/${accountName}/locations`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const locationData = await locationRes.json();
    if (!locationData.locations || locationData.locations.length === 0) {
      return res.status(404).json({ success: false, error: 'No locations found' });
    }

    // Find the verified location automatically
    let verifiedLocation = locationData.locations.find(loc => 
      loc.verificationState === 'VERIFIED' || !loc.verificationState // fallback if state isn't explicitly returned
    );

    // If none explicitly marked verified, default to the first one
    if (!verifiedLocation) {
      verifiedLocation = locationData.locations[0];
    }

    const locationName = verifiedLocation.name; // e.g., "accounts/12345/locations/67890"

    res.json({ success: true, locationName });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch Live Reviews Directly from Google
app.get('/api/reviews', async (req, res) => {
  try {
    const accessToken = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
    const locationName = req.query.locationName;

    if (!accessToken || !locationName) {
      return res.status(400).json({ success: false, error: 'Missing access token or locationName' });
    }

    const response = await fetch(`https://mybusiness.googleapis.com/v4/${locationName}/reviews`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const data = await response.json();
    res.json({ success: true, reviews: data.reviews || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Post Manual or Edited Reply to Google
app.post('/api/reviews/reply', async (req, res) => {
  try {
    const accessToken = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
    const { reviewName, replyText } = req.body; 

    if (!accessToken || !reviewName) {
      return res.status(400).json({ success: false, error: 'Missing access token or reviewName' });
    }

    const response = await fetch(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: replyText })
    });

    const result = await response.json();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

