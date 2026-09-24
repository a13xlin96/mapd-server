'use strict';
const {EngineError} = require('../engineError');
const fail = () => { throw new EngineError('invalid_response', {stage:'transcription'}); };
const finite = n => Number.isFinite(n) && n >= 0;

/** Merge overlapping [startMs,endMs] intervals. Does not count overlap twice. */
function mergeIntervals(intervals, durationMs) {
  if (!finite(durationMs) || !Array.isArray(intervals) || intervals.length > 1000) fail();
  const sorted = intervals.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(finite) ||
        pair[0] >= pair[1] || pair[1] > durationMs) fail();
    return [...pair];
  }).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  const result = [];
  for (const pair of sorted) {
    const previous = result.at(-1);
    if (previous && pair[0] <= previous[1]) previous[1] = Math.max(previous[1], pair[1]);
    else result.push(pair);
  }
  return result;
}

/** Returns the uncovered portions of the actual media timeline. */
function missingIntervals(intervals, durationMs) {
  const covered = mergeIntervals(intervals, durationMs), missing = [];
  let end = 0;
  for (const pair of covered) {
    if (pair[0] > end) missing.push([end, pair[0]]);
    end = pair[1];
  }
  if (end < durationMs) missing.push([end, durationMs]);
  return missing;
}

/**
 * Deterministic audio-cut plan, consumed by the local decoder (no I/O here).
 * 20s maximum chunks, <=1s overlap, <=180s media. Silence boundaries only
 * choose a nearby cut; they never discard quiet audio. coveredIntervals must
 * describe successfully processed timeline, not inferred speech absence.
 * Returns every required interval, including >32 fragmented subtitle gaps.
 * The decoder coalesces these into continuous windows and enforces its
 * 32-chunk dispatch bound; unsent intervals remain honestly uncovered.
 * @returns {Array<{startMs:number,endMs:number}>}
 */
function planAudioSegments(durationMs, {chunkMs=20000, overlapMs=1000,
  silenceBoundariesMs=[], coveredIntervals=[]} = {}) {
  if (!finite(durationMs) || durationMs > 180000 || !finite(chunkMs) || chunkMs < 2000 || chunkMs > 20000 ||
      !finite(overlapMs) || overlapMs > 1000 || overlapMs >= chunkMs ||
      !Array.isArray(silenceBoundariesMs) || silenceBoundariesMs.length > 1000 ||
      !silenceBoundariesMs.every(n => finite(n) && n <= durationMs)) fail();
  const missing=missingIntervals(coveredIntervals,durationMs);
  const plan = [];
  for (const [lo,hi] of missing) {
    let startMs = lo;
    while (startMs < hi) {
      let endMs = Math.min(hi, startMs + chunkMs);
      if (endMs < hi) {
        const near = silenceBoundariesMs.filter(n => n >= endMs-1000 && n <= endMs && n > startMs+overlapMs);
        if (near.length) endMs = Math.max(...near);
      }
      plan.push({startMs, endMs});
      if (endMs === hi) break;
      startMs = endMs - overlapMs;
    }
  }
  return plan;
}

/**
 * Preserve every evidence segment verbatim. Only the display/extraction text
 * removes exact >=3-token boundary repetition in overlapping windows. A short
 * repeated venue name is retained because it can be a distinct mention.
 */
function transcriptText(segments) {
  let result = '', previous;
  for (const segment of [...segments].sort((a,b)=>a.startMs-b.startMs || a.endMs-b.endMs)) {
    let text = segment.text.trim();
    if (previous && segment.startMs < previous.endMs) {
      const left = previous.text.trim().split(/\s+/u), right = text.split(/\s+/u);
      for (let n = Math.min(20,left.length,right.length); n >= 3; n--) {
        if (left.slice(-n).join(' ') === right.slice(0,n).join(' ')) {
          text = right.slice(n).join(' '); break;
        }
      }
    }
    if (text) result += (result ? '\n' : '') + text;
    previous = segment;
  }
  return result;
}

/**
 * A subtitle string alone never bypasses ASR. Callers may supply timed cues
 * and explicit successful read intervals, including known silent spans.
 * @returns {{segments:Array,coveredIntervals:Array<[number,number]>}}
 */
function reusableSubtitles(subtitles, durationMs) {
  if (subtitles == null) return {segments:[], coveredIntervals:[]};
  if (!subtitles || !Array.isArray(subtitles.segments) || subtitles.segments.length > 500 ||
      !['partial','complete'].includes(subtitles.coverage?.status)) fail();
  const segments = subtitles.segments.map((s,i) => {
    if (!s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 16000 ||
        !finite(s.startMs) || !finite(s.endMs) || s.startMs >= s.endMs || s.endMs > durationMs) fail();
    return {evidenceId:`subtitle:${i}:${s.startMs}`, startMs:s.startMs, endMs:s.endMs,
      text:s.text.trim(), timing:'native', origin:'subtitle'};
  });
  if (Buffer.byteLength(JSON.stringify(segments)) > 32000) fail();
  const coveredIntervals = mergeIntervals(subtitles.coverage.intervals || subtitles.coverage.observedIntervalsMs || [], durationMs);
  // Successful timeline intervals must contain each supplied cue.
  if (segments.some(s => !coveredIntervals.some(([lo,hi]) => lo <= s.startMs && hi >= s.endMs)) ||
      (subtitles.coverage.status === 'complete' && missingIntervals(coveredIntervals,durationMs).length)) fail();
  return {segments, coveredIntervals};
}
module.exports = {planAudioSegments, mergeIntervals, missingIntervals, transcriptText, reusableSubtitles};
