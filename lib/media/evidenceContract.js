'use strict';
const {EngineError} = require('../engineError');
const STATES = Object.freeze(['unattempted','unavailable','partial','complete','failed']);
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new EngineError('invalid_response', {stage:'media_evidence'}); };
const number = value => Number.isFinite(value) && value >= 0;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;

/** Validate media-time intervals, retaining gaps and overlap rather than claiming full coverage. */
function validateIntervals(intervals, durationMs) {
  if (!Array.isArray(intervals) || intervals.length > 512 || !number(durationMs)) fail();
  for (const range of intervals) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(number)
        || range[0] >= range[1] || range[1] > durationMs) fail();
  }
  return intervals.map(range => [...range]);
}
function validateCoverage(value, durationMs) {
  if (!plain(value) || !STATES.includes(value.status) || (value.reason != null && !/^[a-z0-9_-]{1,80}$/.test(value.reason))) fail();
  return {status:value.status, ...(value.reason ? {reason:value.reason} : {}),
    intervals:validateIntervals(value.intervals || [], durationMs)};
}
/** A transcription is evidence only. Usage is excluded from the cached/follower payload. */
function validateTranscript(value, durationMs) {
  if (!plain(value) || !text(value.provider,64) || !text(value.model,128)
      || (value.language != null && !/^[a-zA-Z-]{2,20}$/.test(value.language))
      || !Array.isArray(value.segments) || value.segments.length > 512) fail();
  const segments = value.segments.map(segment => {
    if (!plain(segment) || !text(segment.text,16000) || !['chunk','native'].includes(segment.timing)
        || !number(segment.startMs) || !number(segment.endMs) || segment.startMs >= segment.endMs || segment.endMs > durationMs) fail();
    return {text:segment.text,startMs:segment.startMs,endMs:segment.endMs,timing:segment.timing};
  });
  if (Buffer.byteLength(JSON.stringify(segments)) > 64 * 1024) fail();
  return {provider:value.provider,model:value.model,language:value.language || null,segments,
    coverage:validateCoverage(value.coverage,durationMs)};
}
function validateFrame(value, durationMs) {
  if (!plain(value) || !HASH.test(value.digest) || !number(value.timestampMs) || value.timestampMs > durationMs
      || !Number.isInteger(value.width) || value.width < 1 || value.width > 3840
      || !Number.isInteger(value.height) || value.height < 1 || value.height > 3840) fail();
  return {digest:value.digest,timestampMs:value.timestampMs,width:value.width,height:value.height};
}
/** Mechanically check references. The model/test corpus separately evaluates semantic support. */
function validateCandidateEvidence(candidate, evidence) {
  if (!plain(candidate) || !text(candidate.name,300) || !candidate.name.trim()
      || !Array.isArray(candidate.evidenceRefs) || !candidate.evidenceRefs.length || candidate.evidenceRefs.length > 16) fail();
  const refs = candidate.evidenceRefs.map(ref => {
    if (!plain(ref) || !text(ref.evidenceId,128) || !Object.hasOwn(evidence,ref.evidenceId)) fail();
    const source = evidence[ref.evidenceId];
    if (ref.quote != null && (!text(ref.quote,1000) || !ref.quote.trim()
        || (typeof source.text === 'string' && !source.text.normalize('NFKC').includes(ref.quote.normalize('NFKC'))))) fail();
    if (ref.region != null && (!Array.isArray(ref.region) || ref.region.length !== 4
        || !ref.region.every(n => number(n) && n <= 1) || ref.region[0] >= ref.region[2] || ref.region[1] >= ref.region[3])) fail();
    return {...ref};
  });
  return {...candidate,evidenceRefs:refs,requiresSelection:true};
}
module.exports = {STATES,validateIntervals,validateCoverage,validateTranscript,validateFrame,validateCandidateEvidence};
