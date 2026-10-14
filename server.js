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

    const accountRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const accountData = await accountRes.json();

    if (!accountData.accounts || accountData.accounts.length === 0) {
      return res.status(404).json({ success: false, error: 'No Google Business accounts found for this user.' });
    }

    let foundLocationName = null;

    for (const account of accountData.accounts) {
      const accountName = account.name; // e.g., "accounts/109345..."
      
      // Added mandatory readMask for Google Business Information API
      const locationRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storeCode,verificationState`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const locationData = await locationRes.json();
      console.log(`LOCATIONS FOR ${accountName}:`, JSON.stringify(locationData));

      if (locationData.locations && locationData.locations.length > 0) {
        let verifiedLocation = locationData.locations.find(loc => 
          loc.verificationState === 'VERIFIED' || !loc.verificationState
        ) || locationData.locations[0];
        
        foundLocationName = verifiedLocation.name;
        break;
      }
    }

    if (!foundLocationName) {
      return res.status(404).json({ 
        success: false, 
        error: 'No locations found with readMask. Check Render logs for account node outputs.' 
      });
    }

    res.json({ success: true, locationName: foundLocationName });
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
