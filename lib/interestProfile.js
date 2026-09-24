// Compatibility endpoint for older mobile releases. Authentication proves
// who called, not that a pin was saved. Committed pin-write events now own
// accounting in functions/lib/pinAccounting.js. Roll out that capture before
// replacing this route; never trust category-only requests as save events.
const express = require('express');
const { authenticateRequest } = require('./auth');
const router = express.Router();
router.post('/interest-profile/pin-saved', authenticateRequest, (req, res) => {
  const { category } = req.body || {};
  if (typeof category !== 'string' || !category || category.length > 64) {
    return res.status(400).json({ error: 'invalid_category' });
  }
  return res.json({ ok: true });
});
// Temporary import compatibility while older enrichment integrations roll
// forward. This acknowledgement performs no writes and cannot inflate stats.
async function recordPinSaved() { return { capturedBy: 'committed_pin_trigger' }; }
module.exports = { interestProfileRouter: router, recordPinSaved };
