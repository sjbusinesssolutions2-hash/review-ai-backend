const express = require('express');
const router = express.Router();
const passport = require('passport');
const { google } = require('googleapis');
const { fetchLocationReviews } = require('../services/gbpService');

const frontendBaseUrl = process.env.FRONTEND_URL || 'https://sjbusinesssolutions2-hash.github.io/review-ai-app';

router.get('/google', passport.authenticate('google', {
  scope: [
    'profile',
    'email',
    'https://www.googleapis.com/auth/business.manage'
  ],
  accessType: 'offline',
  prompt: 'consent'
}));

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: `${frontendBaseUrl}/login.html` }),
  async (req, res) => {
    try {
      const user = req.user;
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: user.accessToken });

      const mybusinessaccountmanagement = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
      const accountsRes = await mybusinessaccountmanagement.accounts.list();
      const accounts = accountsRes.data.accounts || [];

      for (const acc of accounts) {
        try {
          const accountId = acc.name.split('/')[1];

          const mybusinessinfo = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
          const locsRes = await mybusinessinfo.accounts.locations.list({
            parent: acc.name,
            readMask: 'name,title,storefrontAddress'
          });

          if (locsRes.data.locations) {
            for (const loc of locsRes.data.locations) {
              const locationId = loc.name.split('/')[1];
              const fullAccountLocationPath = `accounts/${accountId}/locations/${locationId}`;

              const reviewData = await fetchLocationReviews(user.accessToken, acc.name, loc.name);
              const addressStr = loc.storefrontAddress && loc.storefrontAddress.addressLines ? loc.storefrontAddress.addressLines.join(', ') : '';

              const existingLocIndex = user.locations.findIndex(l => l.locationId === loc.name || l.accountLocationPath === fullAccountLocationPath);

              if (existingLocIndex !== -1) {
                user.locations[existingLocIndex].locationName = loc.title;
                user.locations[existingLocIndex].accountLocationPath = fullAccountLocationPath;
                user.locations[existingLocIndex].rating = reviewData.rating;
                user.locations[existingLocIndex].reviewCount = reviewData.reviewCount;
                user.locations[existingLocIndex].address = addressStr;
              } else {
                user.locations.push({
                  locationId: loc.name,
                  accountLocationPath: fullAccountLocationPath,
                  locationName: loc.title,
                  rating: reviewData.rating,
                  reviewCount: reviewData.reviewCount,
                  address: addressStr,
                  subscriptionStatus: 'free',
                  autoReplyEnabled: false
                });
              }
            }
          }
        } catch (e) {
          console.warn('Location listing notice:', e.message);
        }
      }

      await user.save();

      const userName = encodeURIComponent(user.displayName || 'User');
      const userEmail = encodeURIComponent(user.email || '');

      res.redirect(`${frontendBaseUrl}/inbox.html?userId=${user._id}&userName=${userName}&userEmail=${userEmail}`);
    } catch (err) {
      console.error('OAuth Callback Error:', err);
      res.redirect(`${frontendBaseUrl}/inbox.html?userId=${req.user._id}&userName=${encodeURIComponent(req.user.displayName || 'User')}`);
    }
  }
);

router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
      });
    } else {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    }
  });
});

module.exports = router;
