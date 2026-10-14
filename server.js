// Automated Sync, AI Generate, and Auto-Post Route
app.post('/api/reviews/autopilot', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No access token provided' });
    }
    const accessToken = authHeader.split(' ')[1];
    const { locationName } = req.body;

    let fullParentPath = locationName || 'accounts/-/locations/default';
    if (!fullParentPath.startsWith('accounts/')) {
      fullParentPath = `accounts/-/locations/${fullParentPath.replace('locations/', '')}`;
    }

    // 1. Fetch live reviews from Google
    const response = await fetch(`https://mybusiness.googleapis.com/v4/${fullParentPath}/reviews`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await response.json();
    const reviews = data.reviews || [];

    let processedCount = 0;
    const activityLog = [];

    for (const review of reviews) {
      // Check if this review already has a reply from Google
      if (review.reviewReply) {
        continue; // Skip already replied reviews
      }

      const reviewText = review.comment || 'Great service!';
      const starRating = review.starRating || 'FIVE';

      // 2. Generate Gemini AI Reply Automatically
      const apiKey = process.env.GEMINI_API_KEY;
      const prompt = `Write a polite, professional, and appreciative business reply for this review:
      Rating: ${starRating} stars
      Review: "${reviewText}"
      Keep it friendly and concise.`;

      const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const aiData = await aiRes.json();
      const replyText = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Thank you for your feedback!";

      // 3. Automatically Post Reply to Google API
      const replyRes = await fetch(`https://mybusiness.googleapis.com/v4/${review.name}/reply`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ comment: replyText })
      });

      if (replyRes.ok) {
        processedCount++;
        activityLog.push({
          reviewer: review.reviewer?.displayName || 'Customer',
          rating: starRating,
          reply: replyText
        });
      }
    }

    res.json({ 
      success: true, 
      message: `Autopilot ran successfully! Automatically replied to ${processedCount} new review(s).`,
      activityLog 
    });
  } catch (error) {
    console.error('Autopilot error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
