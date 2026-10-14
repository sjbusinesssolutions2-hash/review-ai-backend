const express = require('express');
const app = express();

app.use(express.json());

// 1. Fetch Location ID
app.get('/api/locations', async (req, res) => {
  try {
    const accessToken = req.user.accessToken; // Retrieved from your user session/database

    const accountRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const accountData = await accountRes.json();
    const accountName = accountData.accounts[0].name; // e.g., "accounts/12345"

    const locationRes = await fetch(`https://mybusinessinformation.googleapis.com/v1/${accountName}/locations`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const locationData = await locationRes.json();
    const locationName = locationData.locations[0].name; // e.g., "accounts/12345/locations/67890"

    res.json({ success: true, locationName });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch Live Reviews Directly from Google
app.get('/api/reviews', async (req, res) => {
  try {
    const accessToken = req.user.accessToken;
    const locationName = req.user.locationName; // Stored from the step above

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
    const accessToken = req.user.accessToken;
    const { reviewName, replyText } = req.body; 
    // reviewName format: "accounts/123/locations/456/reviews/789"

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
