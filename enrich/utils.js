function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanSocialText(text) {
  return text
    .replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/#\w+/g, '')
    .replace(/@\w+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[|•·—–]/g, ' ')
    .replace(/\bon Instagram\b/gi, '')
    .replace(/\bon TikTok\b/gi, '')
    .replace(/\bReels?\b/gi, '')
    .replace(/\blikes?,?\s*\d+\s*comments?\b/gi, '')
    .replace(/\d+\s*likes?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { decodeHtmlEntities, cleanSocialText };
