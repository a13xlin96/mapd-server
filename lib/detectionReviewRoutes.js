'use strict';
const {reviewDetections, DetectionReviewError} = require('./detectionReview');

function registerDetectionReviewRoute(app, {db, authenticateRequest, apiLimiter, serverTimestamp}) {
  app.post('/enrich/review', apiLimiter, authenticateRequest, async (req, res) => {
    // The shared middleware also accepts an operator token plus an arbitrary
    // body userId. Only a verified user's own decision is authoritative here.
    if (req.adminBypass || !req.authUid) return res.status(403).json({error: 'access_blocked'});
    try { return res.json(await reviewDetections(db, req.authUid, req.body, {serverTimestamp})); }
    catch (error) {
      if (error instanceof DetectionReviewError) return res.status(error.status).json({error: error.code});
      return res.status(503).json({error: 'review_unavailable'});
    }
  });
}
module.exports = {registerDetectionReviewRoute};
