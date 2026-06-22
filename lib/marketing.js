// Marketing & growth surface: tracked-link redirector, waitlist capture, and a
// public "get the app" landing page. All install destinations are env-driven so
// we can point them at the TestFlight public link / App Store / Play Store as
// each goes live, without a code change.
//
// Routes:
//   GET  /go/:campaign  — logs a click to Firestore `marketingClicks`, then
//                         302s to the right install destination by device.
//   GET  /get           — public landing + waitlist email capture page.
//   POST /waitlist      — { email, ref, utm_source } -> Firestore `waitlist`.
//
// Also exports helpers (storeButtonsHtml, ogImageMeta, logClick) reused by the
// /invite landing page in index.js so all public pages share one source of truth.

const express = require('express');
const { firestore, admin } = require('./firestore');

const router = express.Router();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://mapd-server.onrender.com').replace(/\/$/, '');
const WAITLIST_URL = `${PUBLIC_BASE_URL}/get`;
// Until the public TestFlight link / store listings exist, these fall back to
// the waitlist page. Set them as Render env vars when each goes live.
const IOS_INSTALL_URL = process.env.IOS_INSTALL_URL || WAITLIST_URL;
const ANDROID_INSTALL_URL = process.env.ANDROID_INSTALL_URL || WAITLIST_URL;
// Optional social-share preview image (e.g. a branded cover or generated map).
const OG_IMAGE_URL = process.env.OG_IMAGE_URL || '';

function detectDevice(ua = '') {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

function installUrlForDevice(device) {
  if (device === 'ios') return IOS_INSTALL_URL;
  if (device === 'android') return ANDROID_INSTALL_URL;
  return WAITLIST_URL;
}

// Fire-and-forget click logging. Never blocks the redirect or throws into the
// request path.
function logClick(req, { campaign = null, type = 'go' } = {}) {
  try {
    const q = req.query || {};
    firestore
      .collection('marketingClicks')
      .add({
        campaign,
        type, // 'go' | 'invite' | 'get'
        utm_source: q.utm_source || null,
        utm_medium: q.utm_medium || null,
        utm_campaign: q.utm_campaign || null,
        ref: q.ref || null,
        referer: req.get('referer') || null,
        ua: req.get('user-agent') || null,
        device: detectDevice(req.get('user-agent')),
        ts: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((e) => console.warn('[marketing] click log failed:', e.message));
  } catch (e) {
    console.warn('[marketing] click log error:', e.message);
  }
}

// Shared store-button block for landing pages. Real, device-targeted links
// (falls back to the waitlist page until stores are live).
function storeButtonsHtml() {
  return `
  <div class="stores">
    <a href="${IOS_INSTALL_URL}">Get it on iOS</a>
    <a href="${ANDROID_INSTALL_URL}">Get it on Android</a>
  </div>`;
}

function ogImageMeta() {
  return OG_IMAGE_URL ? `\n  <meta property="og:image" content="${OG_IMAGE_URL}">` : '';
}

// GET /go/:campaign — tracked redirect.
router.get('/go/:campaign', (req, res) => {
  const { campaign } = req.params;
  logClick(req, { campaign, type: 'go' });

  const device = detectDevice(req.get('user-agent'));
  let target = installUrlForDevice(device);

  // When we fall back to the waitlist (stores not live yet), carry the campaign
  // through so the waitlist signup can be attributed to the source post.
  if (target === WAITLIST_URL) {
    const ref = encodeURIComponent(req.query.ref || campaign || '');
    const src = encodeURIComponent(req.query.utm_source || 'go');
    target += `?ref=${ref}&utm_source=${src}`;
  }
  res.redirect(302, target);
});

// POST /waitlist — capture an email. Doc id = base64url(email) for idempotency.
router.post('/waitlist', async (req, res) => {
  const { email, ref, utm_source } = req.body || {};
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  try {
    const id = Buffer.from(normalized).toString('base64url');
    await firestore.collection('waitlist').doc(id).set(
      {
        email: normalized,
        ref: ref || null,
        utm_source: utm_source || null,
        ua: req.get('user-agent') || null,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[marketing] waitlist save failed:', e.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// GET /get — public landing + waitlist page.
router.get('/get', (req, res) => {
  logClick(req, { campaign: req.query.ref || null, type: 'get' });
  const storesLive = IOS_INSTALL_URL !== WAITLIST_URL || ANDROID_INSTALL_URL !== WAITLIST_URL;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mapd — your places, on your map</title>
  <meta name="description" content="Turn the places you save on TikTok & Instagram into a map you can actually use.">
  <meta property="og:title" content="Mapd — turn saved TikToks & Reels into a map">
  <meta property="og:description" content="Save a place from TikTok or Instagram and Mapd pins it on your map automatically.">${ogImageMeta()}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #F9F8F6; color: #1C1917;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 100vh; padding: 24px; text-align: center;
    }
    .logo { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 12px; max-width: 520px; line-height: 1.2; }
    .subtitle { font-size: 17px; color: #57534E; margin-bottom: 28px; line-height: 1.5; max-width: 460px; }
    .stores { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-bottom: 28px; }
    .stores a {
      padding: 12px 22px; background: #1C1917; color: #fff; border-radius: 10px;
      text-decoration: none; font-size: 15px; font-weight: 600;
    }
    form { display: flex; gap: 8px; width: 100%; max-width: 380px; }
    input[type=email] {
      flex: 1; padding: 14px 16px; border: 1px solid #E7E5E4; border-radius: 12px;
      font-size: 16px; background: #fff;
    }
    button {
      padding: 14px 20px; background: #D4622A; color: #fff; border: none; border-radius: 12px;
      font-size: 15px; font-weight: 600; cursor: pointer;
    }
    .note { font-size: 13px; color: #A8A29E; margin-top: 14px; }
    .ok { color: #16803C; font-weight: 600; margin-top: 14px; display: none; }
    .footer { margin-top: 40px; font-size: 12px; color: #A8A29E; }
  </style>
</head>
<body>
  <div class="logo">📍</div>
  <h1>Turn your saved TikToks &amp; Reels into a map</h1>
  <p class="subtitle">Share a place from TikTok or Instagram and Mapd pins it on your map automatically — with the address, hours, and photos filled in.</p>

  ${storesLive ? storeButtonsHtml() : ''}

  <form id="waitlist">
    <input type="email" id="email" placeholder="you@email.com" required>
    <button type="submit">${storesLive ? 'Get updates' : 'Join the beta'}</button>
  </form>
  <p class="ok" id="ok">You're on the list — we'll be in touch. 🎉</p>
  <p class="note">${storesLive ? "Or grab the app above." : "We'll send you the link the moment it's ready."}</p>

  <p class="footer">Mapd — your places, on your map</p>

  <script>
    var params = new URLSearchParams(window.location.search);
    document.getElementById('waitlist').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('email').value;
      fetch('/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          ref: params.get('ref'),
          utm_source: params.get('utm_source'),
        }),
      }).then(function (r) {
        if (r.ok) {
          document.getElementById('waitlist').style.display = 'none';
          document.getElementById('ok').style.display = 'block';
        }
      });
    });
  </script>
</body>
</html>`);
});

module.exports = { router, logClick, storeButtonsHtml, ogImageMeta };
