async function fetchLocationReviews(accessToken, accountName, locationName) {
  try {
    let parentPath = locationName;
    if (!locationName.startsWith('accounts/')) {
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
    }
  } catch (err) {
    console.warn(`Fetch reviews notice for ${locationName}:`, err.message);
  }
  return { reviews: [], reviewCount: 0, rating: 5.0, parentPath: locationName };
}

async function publishPostToGoogle(accessToken, accountLocationPath, summary, publicImageUrl) {
  try {
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
  fetchLocationReviews,
  publishPostToGoogle
};
