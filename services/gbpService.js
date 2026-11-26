const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isTransientError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('resource_exhausted') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('network')
  );
}

// Fetch wrapper with retry + exponential backoff + jitter for transient HTTP/network failures
async function fetchWithBackoff(url, options = {}, label = 'GBP API', maxRetries = 2) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!isTransientStatus(response.status) || attempt >= maxRetries) {
        return response;
      }

      attempt += 1;
      const baseDelay = Math.min(8000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 600);
      const waitMs = baseDelay + jitter;

      console.log(`[${label}] HTTP ${response.status} (retry ${attempt}/${maxRetries}), waiting ${waitMs}ms...`);
      await sleep(waitMs);
    } catch (err) {
      clearTimeout(timeoutId);

      if (!isTransientError(err) || attempt >= maxRetries) {
        throw err;
      }

      attempt += 1;
      const baseDelay = Math.min(8000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 600);
      const waitMs = baseDelay + jitter;

      console.log(`[${label}] Transient error (${err.message}) on retry ${attempt}/${maxRetries}, waiting ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
}

async function getValidAccessToken(user) {
  if (!user || !user.refreshToken) return user?.accessToken;

  try {
    const response = await fetchWithBackoff(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: user.refreshToken,
          grant_type: 'refresh_token'
        }),
        timeoutMs: 10000
      },
      'OAuth Token',
      2
    );

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

async function fetchLocationReviews(userOrToken, accountName, locationName, pageSize = null) {
  try {
    const isUserObj = typeof userOrToken === 'object' && userOrToken !== null;
    let accessToken = isUserObj ? await getValidAccessToken(userOrToken) : userOrToken;

    let parentPath = locationName;
    if (locationName.startsWith('accounts/')) {
      parentPath = locationName;
    } else if (accountName) {
      parentPath = `${accountName}/${locationName}`;
    }

    const url = pageSize
      ? `https://mybusiness.googleapis.com/v4/${parentPath}/reviews?pageSize=${pageSize}`
      : `https://mybusiness.googleapis.com/v4/${parentPath}/reviews`;

    let res = await fetchWithBackoff(
      url,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeoutMs: 15000
      },
      'GBP Reviews',
      2
    );

    // If token expired mid-session, refresh once and retry
    if (res.status === 401 && isUserObj && userOrToken.refreshToken) {
      accessToken = await getValidAccessToken(userOrToken);
      res = await fetchWithBackoff(
        url,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeoutMs: 15000
        },
        'GBP Reviews Retry',
        1
      );
    }

    if (res.ok) {
      const data = await res.json();
      const reviews = data.reviews || [];
      const count = data.totalReviewCount || reviews.length;
      let rating = data.averageRating || 5.0;

      if (reviews.length > 0 && !data.averageRating) {
        const totalStars = reviews.reduce((acc, r) => {
          const val =
            r.starRating === 'FIVE'
              ? 5
              : r.starRating === 'FOUR'
              ? 4
              : r.starRating === 'THREE'
              ? 3
              : r.starRating === 'TWO'
              ? 2
              : 1;
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
    const isUserObj = typeof userOrToken === 'object' && userOrToken !== null;
    let accessToken = isUserObj ? await getValidAccessToken(userOrToken) : userOrToken;

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
      postPayload.media = [
        {
          mediaFormat: 'PHOTO',
          sourceUrl: publicImageUrl
        }
      ];
    }

    const requestInit = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postPayload),
      timeoutMs: 20000
    };

    let res = await fetchWithBackoff(endpoint, requestInit, 'GBP Publish Post', 2);

    // If token expired mid-session, refresh once and retry
    if (res.status === 401 && isUserObj && userOrToken.refreshToken) {
      accessToken = await getValidAccessToken(userOrToken);
      res = await fetchWithBackoff(
        endpoint,
        {
          ...requestInit,
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        },
        'GBP Publish Post Retry',
        1
      );
    }

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
