const { isAllowedExtractUrl } = require('../lib/urlValidation');

describe('isAllowedExtractUrl', () => {
  test.each([
    'https://www.tiktok.com/t/ZT8abc123/',
    'https://vm.tiktok.com/ZT8abc123/',
    'https://www.instagram.com/reel/Cabc123/',
    'https://instagr.am/p/Cabc123/',
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://maps.app.goo.gl/xyz',
    'https://goo.gl/maps/abc123',
    'https://www.google.com/maps/place/abc',
  ])('allows %s', (url) => {
    expect(isAllowedExtractUrl(url)).toBe(true);
  });

  test.each([
    '--config-location=/tmp/evil',          // yt-dlp option injection
    'file:///etc/passwd',                    // non-https scheme
    'http://169.254.169.254/latest/',        // SSRF to metadata service
    'https://evil.example.com/video',        // host not on allowlist
    'not a url at all',
    'https://tiktok.com.evil.example.com/video', // suffix-spoofing lookalike host
    'https://eviltiktok.com/video',              // substring lookalike, not a real subdomain
  ])('rejects %s', (url) => {
    expect(isAllowedExtractUrl(url)).toBe(false);
  });
});
