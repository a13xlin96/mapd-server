'use strict';
const {createHash} = require('crypto');
const {validateRef} = require('./labeledEvaluationSchemaV2');
const {checksum} = require('./labeledEvaluationSchema');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => {throw new Error('Invalid runtime/capture evidence binding');};
const clone = x => JSON.parse(JSON.stringify(x));
const unique = refs => [...new Map(refs.map(r => [checksum(r), r])).values()];
/** Bridge runtime evidence IDs to a label-blind capture manifest. Bytes are
 * hashed before binding. Decoder provenance is trusted only from the registered
 * local processor, not JSON recordings or corpus answers. Crop coordinates are
 * mapped back to the original image. Audio retains honest chunk windows. */
function createCaptureEvidenceBridge(assets) {
  const entries = new Map(), descriptors = assets.map(({bytes, ...a}) => a);
  const descriptor = id => descriptors.find(a => a.assetId === id);
  const checked = asset => {
    const a = descriptor(asset.assetId);
    if (!a || !Buffer.isBuffer(asset.bytes) || hash(asset.bytes) !== a.sha256 || asset.bytes.length !== a.byteLength) fail();
    return a;
  };
  const add = (id, entry) => {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || entries.has(id)) fail();
    validateRef(entry.ref, descriptors); entries.set(id, entry);
  };
  function addText(asset) {
    const a = checked(asset);
    if (!['caption', 'subtitles'].includes(a.kind)) fail();
    const text = new TextDecoder('utf-8', {fatal: true}).decode(asset.bytes);
    if (text.length !== a.textLength) fail();
    const evidenceId = `capture:${a.assetId}`;
    const ref = {assetId: a.assetId, modality: 'text', intervalMs: a.durationMs === null ? null : [0, a.durationMs], textRange: [0, text.length], region: null};
    add(evidenceId, {ref, text});
    return {evidenceId, modality: a.kind === 'caption' ? 'caption' : 'subtitle', text};
  }
  function audioRef(assetId, startMs, endMs) {
    const a = descriptor(assetId);
    if (!a || !['audio', 'video'].includes(a.kind) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || startMs >= endMs || endMs > a.durationMs + 1) fail();
    // PCM sample boundaries may be fractional milliseconds. Outward rounding
    // preserves the actual containing window; no word timing is claimed.
    return {assetId, modality: 'audio', intervalMs: [Math.floor(startMs), Math.min(a.durationMs, Math.ceil(endMs))], textRange: null, region: null};
  }
  function addTranscript(transcript, chunks, video) {
    const a = checked(video);
    if (transcript.mediaDigest !== a.sha256) fail();
    const byHash = new Map();
    for (const c of chunks) {
      if (!Buffer.isBuffer(c.audioBytes) || hash(c.audioBytes) !== c.audioSha256) fail();
      byHash.set(c.audioSha256, [...(byHash.get(c.audioSha256) || []), c]);
    }
    return transcript.segments.map(s => {
      const chunk = byHash.get(s.audioSha256)?.find(c => s.startMs >= c.startMs && s.endMs <= c.endMs &&
        s.evidenceId?.startsWith(`audio:${c.audioSha256}:${c.startMs}:`));
      if (s.origin !== 'audio' || !chunk || s.startMs < chunk.startMs || s.endMs > chunk.endMs || typeof s.text !== 'string') fail();
      const ref = audioRef(a.assetId, s.startMs, s.endMs);
      add(s.evidenceId, {ref, text: s.text});
      return {evidenceId: s.evidenceId, modality: 'transcript', text: s.text, startMs: s.startMs, endMs: s.endMs};
    });
  }
  function addFrames(frames, video) {
    const a = checked(video);
    return frames.map(frame => {
      if (!Buffer.isBuffer(frame.bytes) || hash(frame.bytes) !== frame.digest || frame.sourceDigest !== a.sha256 || !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > a.durationMs) fail();
      const crop = frame.crop || [0, 0, 1, 1];
      const ref = {assetId: a.assetId, modality: 'frame', intervalMs: [frame.timestampMs, frame.timestampMs], textRange: null, region: [...crop]};
      const evidenceId = `frame:${frame.digest}:${frame.timestampMs}`;
      add(evidenceId, {ref, crop: [...crop], frameDigest: frame.digest}); return ref;
    });
  }
  /** Call only with shipped videoVision's validated observations. A derived
   * visual ID retains its actual source frame time/crop and literal OCR quote;
   * it is not a new independent frame or proof that the OCR was correct. */
  function addVisualObservations(observations) {
    return observations.map((o, i) => {
      const source = entries.get(o.evidenceId);
      if (!source?.frameDigest) fail();
      const ref = reference({...o, supports: 'name'}), evidenceId = `${o.evidenceId}:obs:${i}`;
      add(evidenceId, {ref, text: o.quote});
      return {evidenceId, modality: 'visual', text: o.quote};
    });
  }
  function reference(value) {
    const entry = entries.get(value?.evidenceId);
    if (!entry || typeof value.quote !== 'string' || !value.quote.trim() || !['name', 'city', 'address', 'country'].includes(value.supports)) fail();
    const ref = clone(entry.ref);
    if (entry.text !== undefined) {
      if (!entry.text.normalize('NFKC').includes(value.quote.normalize('NFKC')) || value.region != null) fail();
      if (ref.textRange !== null) {
        const at = entry.text.indexOf(value.quote);
        // Equivalent Unicode may change string length; keep the full original
        // span rather than manufacture a falsely precise offset.
        if (at >= 0) ref.textRange = [at, at + value.quote.length];
      }
    } else {
      const r = value.region;
      if (!Array.isArray(r) || r.length !== 4 || r.some(n => !Number.isFinite(n) || n < 0 || n > 1) || r[0] >= r[2] || r[1] >= r[3]) fail();
      const [x, y, right, bottom] = entry.crop, w = right - x, h = bottom - y;
      ref.region = [x + r[0] * w, y + r[1] * h, x + r[2] * w, y + r[3] * h];
    }
    validateRef(ref, descriptors); return ref;
  }
  function observation(place) {
    if (!place || typeof place.name !== 'string' || !Array.isArray(place.evidenceRefs)) fail();
    const mapped = place.evidenceRefs.map(r => ({supports: r.supports, ref: reference(r)}));
    return {query: [place.name, place.address, place.city].filter(Boolean).join(' '), name: place.name,
      city: place.city || null, address: place.address || null, country: place.country || null,
      nameRefs: unique(mapped.filter(r => r.supports === 'name').map(r => r.ref)),
      branchRefs: unique(mapped.filter(r => r.supports !== 'name').map(r => r.ref)), requiresSelection: true};
  }
  return Object.freeze({addText, addTranscript, addFrames, addVisualObservations, audioRef, reference, observation});
}
module.exports = {createCaptureEvidenceBridge};
