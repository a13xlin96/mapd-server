'use strict';
const {createEngineFeatures} = require('./engineFeatures');
const {mediaEligibility} = require('./media/mediaEligibility');
const {rankPlaces} = require('../enrich/confidence');

/** A local evaluation capability, never a production user's feature snapshot. */
function replayFeatures(policy = {}) {
  return createEngineFeatures({version: 'media-replay-v1', snapshotVersion: 2,
    internalUids: ['evaluation-only'], flags: {mediaEvidence: true, languageRouting: true}, mediaPolicy: policy})
    .selectForVerifiedUid('evaluation-only', ['mediaRecoveryV1']);
}
// Routing surrogates exercise the shipped provider classification only. These
// are NOT source identities, never fetched, and never sent to a media reader.
const ROUTES = Object.freeze({instagram: 'https://www.instagram.com/reel/captured/',
  tiktok: 'https://www.tiktok.com/@captured/video/123456789', youtube: 'https://www.youtube.com/watch?v=abcdefghijk'});
/** Use captured caption/subtitle bytes and provisional frozen-Places matches.
 * No corpus labels, support annotations, needsMoreEvidence flag, or URLs read
 * from provider output can influence the shipped eligibility policy. */
function selectiveDecision({caseId, platform, assets, baseline, places, features = replayFeatures()}) {
  const text = kind => assets.filter(a => a.kind === kind && Buffer.isBuffer(a.bytes)).map(a => a.bytes.toString('utf8')).join('\n');
  const ogData = {description: text('caption'), subtitles: text('subtitles')};
  const extracted = {is_carousel: !assets.some(a => a.kind === 'video'), subtitles: ogData.subtitles || null};
  const candidates = baseline?.observations || [];
  const matches = {unresolvedCount: 0, requiresSelection: false};
  for (const c of candidates) {
    const response = places.entries.find(e => e.caseId === caseId && e.query === c.query);
    const ranked = response ? rankPlaces(response.results, ogData, {...c, source: 'caption'}) : null;
    if (!ranked?.place) matches.unresolvedCount++;
    matches.requiresSelection ||= !!ranked?.requiresSelection;
  }
  const decision = mediaEligibility({features, url: ROUTES[platform] || 'https://invalid.example/',
    extracted, ogData, places: candidates, matches});
  return {audio: decision.run, frames: decision.run};
}
module.exports = {replayFeatures, selectiveDecision};
