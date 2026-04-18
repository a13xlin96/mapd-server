const axios = require('axios');
const { decodeHtmlEntities } = require('./utils');

async function fetchOGMetadata(url) {
  const empty = { title: '', description: '', image: '', url, siteName: '' };

  try {
    const isSocial = url.includes('tiktok.com') || url.includes('instagram.com');
    const userAgent = isSocial
      ? 'facebookexternalhit/1.1'
      : 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
      maxContentLength: 100000,
      maxRedirects: 5,
    });

    const html = typeof response.data === 'string' ? response.data : '';

    const getMetaContent = (property) => {
      const regex = new RegExp(
        `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']` +
        `|<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
        'i'
      );
      const match = html.match(regex);
      return decodeHtmlEntities((match && (match[1] || match[2])) || '');
    };

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const titleTag = decodeHtmlEntities((titleMatch && titleMatch[1] && titleMatch[1].trim()) || '');

    return {
      title: getMetaContent('og:title') || getMetaContent('twitter:title') || titleTag,
      description: getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description') || '',
      image: getMetaContent('og:image') || getMetaContent('twitter:image') || '',
      url: getMetaContent('og:url') || url,
      siteName: getMetaContent('og:site_name') || '',
    };
  } catch {
    return empty;
  }
}

async function resolveShortUrl(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 5,
      timeout: 8000,
    });
    return (response.request && (response.request.responseURL || (response.request._redirectable && response.request._redirectable._currentUrl))) || url;
  } catch (error) {
    const req = error && error.request;
    return (req && (req.responseURL || (req._redirectable && req._redirectable._currentUrl))) || url;
  }
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
