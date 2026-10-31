async function getValidAccessToken(user) {
  if (!user || !user.refreshToken) return user?.accessToken;

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: user.refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.access_token) {
        user.accessToken = data.access_token;
        await user.save();
        return data.access_token;
      }
    } else {
      const errText = await response.text();
      console.error(`[Auth] Failed to refresh access token:`, errText);
    }
  } catch (err) {
    console.error(`[Auth] Error refreshing token:`, err.message);
  }

  return user.accessToken;
}

async function fetchLocationReviews(userOrToken, accountName, locationName) {
  try {
    // Automatically support passing either a user object or a raw token string
    let accessToken = userOrToken;
    if (typeof userOrToken === 'object' && userOrToken !== null) {
      accessToken = await getValidAccessToken(userOrToken);
    }

    let parentPath = locationName;
    if (locationName.startsWith('accounts/')) {
      parentPath = locationName;
    } else if (accountName) {
      parentPath = `${accountName}/${locationName}`;
    }

    const res = await fetch(`https://mybusiness.googleapis.com/v4/${parentPath}/reviews`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const reviews = data.reviews || [];
      const count = data.totalReviewCount || reviews.length;
      let rating = data.averageRating || 5.0;

      if (reviews.length > 0 && !data.averageRating) {
        const totalStars = reviews.reduce((acc, r) => {
          const val = r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1;
          return acc + val;
        }, 0);
        rating = totalStars / reviews.length;
      }

      return {
        reviews,
        reviewCount: count,
        rating: parseFloat(rating.toFixed(1)),
        parentPath
      };
    } else {
      const errText = await res.text();
      console.error(`[gbpService] Google Reviews API Error (${res.status}):`, errText);
    }
  } catch (err) {
    console.warn(`Fetch reviews notice for ${locationName}:`, err.message);
  }
  return { reviews: [], reviewCount: 0, rating: 5.0, parentPath: locationName };
}

async function publishPostToGoogle(userOrToken, accountLocationPath, summary, publicImageUrl) {
  try {
    let accessToken = userOrToken;
    if (typeof userOrToken === 'object' && userOrToken !== null) {
      accessToken = await getValidAccessToken(userOrToken);
    }

    const endpoint = `https://mybusiness.googleapis.com/v4/${accountLocationPath}/localPosts`;

    const postPayload = {
      languageCode: 'en-US',
      summary: summary,
      topicType: 'STANDARD',
      callToAction: {
        actionType: 'LEARN_MORE',
        url: 'https://sjbs.ai'
      }
    };

    if (publicImageUrl) {
      postPayload.media = [{
        mediaFormat: 'PHOTO',
        sourceUrl: publicImageUrl
      }];
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postPayload)
    });

    if (res.ok) {
      const data = await res.json();
      return { success: true, googlePostId: data.name || 'published' };
    } else {
      const errText = await res.text();
      return { success: false, error: errText };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  getValidAccessToken,
  fetchLocationReviews,
  publishPostToGoogle
};
