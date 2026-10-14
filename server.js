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

// 1. Fetch Location ID Route (Corrected Google API Domains 
app.get('/api/locations', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];

    // Direct wildcard query across all authorized accounts/locations
    const locationRes = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations?readMask=name,title,storeCode,verificationState', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const locationText = await locationRes.text();
    console.log("WILDCARD LOCATIONS RESPONSE:", locationText);

    if (locationText.startsWith('<!DOCTYPE') || locationText.startsWith('<html')) {
      return res.status(500).json({ success: false, error: 'Google Locations API error or invalid token scope.' });
    }

    const locationData = JSON.parse(locationText);
    if (!locationData.locations || locationData.locations.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No locations found. Verify that your Google account has active manager/owner rights on a live business profile.' 
      });
    }

    let verifiedLocation = locationData.locations.find(loc => 
      loc.verificationState === 'VERIFIED' || !loc.verificationState
    ) || locationData.locations[0];

    res.json({ success: true, locationName: verifiedLocation.name });
  } catch (error) {
    console.error('Server error in /api/locations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch Live Reviews Directly from Google
app.get('/api/reviews', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];
    const locationName = req.query.locationName;

    if (!locationName) {
      return res.status(400).json({ success: false, error: 'Missing locationName parameter' });
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
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];
    const { reviewName, replyText } = req.body; 

    if (!reviewName) {
      return res.status(400).json({ success: false, error: 'Missing reviewName' });
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

// Port Listener
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
