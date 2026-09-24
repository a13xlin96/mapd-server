'use strict';
const {mediaConfigForFeatures} = require('./mediaConfig');
const {classifyContentProvider,isYouTubeVideoUrl} = require('../contentProvider');
const {normalizePlaceName} = require('../placeNameNormalize');

function videoEligible({features,url,extracted}) {
  if (!mediaConfigForFeatures(features) || extracted?.is_carousel) return false;
  const provider=classifyContentProvider(url);
  return ['instagram','tiktok'].includes(provider) ||
    features.versions.languageRouting==='multilingual-v1' && isYouTubeVideoUrl(url);
}
function expectedPlaceCount(text) {
  const match=String(text || '').match(/\b(?:top|best|my|these|visit|try)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:places|restaurants|cafes|cafés|bars|spots|stops)\b/i);
  return match ? Math.min(40,Number(match[1] || match[2])) : null;
}
/** Deterministic, recorded policy. A valid caption match alone cannot prove a
 * video's spoken/visual venues have been covered. Evaluation compares this
 * selective policy with an always-analyze arm before rollout. */
function mediaEligibility({features,url,extracted,ogData={},places=[],matches,attempted=false,analysisRetry=false}) {
  if (!videoEligible({features,url,extracted})) return {run:false,reason:'feature_or_source_disabled'};
  if (attempted) return {run:false,reason:'already_attempted'};
  if (analysisRetry) return {run:true,reason:'explicit_analysis_retry'};
  const text=[ogData.title,ogData.description].filter(Boolean).join('\n');
  if (text.trim().length<80 || !places.length) return {run:true,reason:'thin_text'};
  const expected=expectedPlaceCount(text);
  if (expected && places.length<expected) return {run:true,reason:'incomplete_listicle'};
  if (!extracted?.subtitles || extracted?.subtitle_failures?.length) return {run:true,reason:'missing_subtitle_coverage'};
  if (places.some(p=>p.requiresSelection || p.contradictions?.length)) return {run:true,reason:'conflicting_identity'};
  if (matches && (matches.unresolvedCount || matches.requiresSelection)) return {run:true,reason:'weak_google_match'};
  return {run:false,reason:matches?'baseline_sufficient':'provisional_matching'};
}
/** Equal names without geography are not proof of equal chain branches. Only
 * matching identity fields collapse. A conflict makes every affected branch
 * require confirmation, including the previously automatic baseline. */
function mergeCandidates(baseline,media,{limit=40,onOverflow,contradictions=[]}={}) {
  const normalized=p=>[p.name,p.city,p.country,p.address].map(v=>normalizePlaceName(v || ''));
  const map=new Map();
  for (const p of baseline) {
    if (!p || typeof p.name!=='string' || !p.name.trim()) continue;
    map.set(normalized(p).join('|'),{...p});
  }
  for (const p of media) {
    if (!p || typeof p.name!=='string' || !p.name.trim()) continue;
    const key=normalized(p).join('|'),existing=map.get(key);
    // An identical verified baseline candidate retains its baseline decision.
    if (!existing) map.set(key,{...p,requiresSelection:true});
    else if (p.contradictions?.length) map.set(key,{...existing,requiresSelection:true});
  }
  const places=[...map.values()];
  for (const p of places) {
    const [name,city,country,address]=normalized(p);
    const conflicts=places.some(other=>{
      if(other===p)return false;
      const [n,c,co,a]=normalized(other);
      return n===name && ((city && c && city!==c) || (country && co && country!==co) || (address && a && address!==a));
    });
    if(conflicts || contradictions.some(c=>normalizePlaceName(c.name)===name))p.requiresSelection=true;
  }
  if(places.length>limit)onOverflow?.(places.slice(limit));
  return places.slice(0,limit);
}
module.exports={videoEligible,mediaEligibility,expectedPlaceCount,mergeCandidates};
