const {fetchPublic} = require('../lib/publicFetch');
const axios = require('axios');
const {parsePage, MAX_HTML_BYTES} = require('../lib/postMetadata');
const {asEngineError} = require('../lib/engineError');

async function fetchOGMetadata(url) {

  try {
    const isSocial = url.includes('tiktok.com') || url.includes('instagram.com');
    const userAgent = isSocial
      ? 'facebookexternalhit/1.1'
      : 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

    const response = await fetchPublic(url, axios, {
      timeout: 10000,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
      maxContentLength: MAX_HTML_BYTES,
    });

    const html = typeof response.data === 'string' ? response.data : '';

    const {scripts, ...metadata} = parsePage(html);
    return {...metadata, url:metadata.url || url};
  } catch (error) {
    throw asEngineError(error, {stage:'metadata', provider:'source'});
  }
}

async function resolveShortUrl(url) {
  const response=await fetchPublic(url,axios,{method:'HEAD'});
  return response.url;
}

function isGoogleMapsUrl(url) {
  return url.includes('google.com/maps') || url.includes('maps.google') || url.includes('goo.gl/maps') || url.includes('maps.app.goo.gl');
}

function parseGoogleMapsUrl(url) {
  if (!isGoogleMapsUrl(url)) return null;

  let placeName = '';
  let lat;
  let lng;

  const placeMatch = url.match(/\/place\/([^/@]+)/);
  if (placeMatch) {
    placeName = decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ');
  }

  const coordMatch = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (coordMatch) {
    lat = parseFloat(coordMatch[1]);
    lng = parseFloat(coordMatch[2]);
  }

  if (!placeName) {
    const qMatch = url.match(/[?&]q=([^&]+)/);
    if (qMatch) {
      placeName = decodeURIComponent(qMatch[1]).replace(/\+/g, ' ');
    }
  }

  if (placeName || (lat && lng)) {
    return { placeName, lat, lng };
  }

  return null;
}

module.exports = { fetchOGMetadata, resolveShortUrl, isGoogleMapsUrl, parseGoogleMapsUrl };
