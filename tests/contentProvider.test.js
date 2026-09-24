const { classifyContentProvider, isYouTubeVideoUrl } = require('../lib/contentProvider');

test.each([
  ['https://instagram.com/p/ABC/', 'instagram'],
  ['https://www.instagram.com/reel/ABC/', 'instagram'],
  ['https://m.instagram.com/p/ABC/', 'instagram'],
  ['https://instagr.am/ABC/', 'instagram'],
  ['https://tiktok.com/@chef/video/123', 'tiktok'],
  ['https://www.tiktok.com/@chef/photo/123', 'tiktok'],
  ['https://m.tiktok.com/v/123.html', 'tiktok'],
  ['https://vm.tiktok.com/ABC/', 'tiktok'],
  ['https://vt.tiktok.com/ABC/', 'tiktok'],
  ['https://youtube.com/watch?v=abc123', 'youtube'],
  ['https://www.youtube.com/shorts/abc123', 'youtube'],
  ['https://m.youtube.com/watch?v=abc123', 'youtube'],
  ['https://youtu.be/abc123', 'youtube'],
])('classifies exact provider URL %s', (url, provider) => {
  expect(classifyContentProvider(url)).toBe(provider);
  if (provider === 'youtube') expect(isYouTubeVideoUrl(url)).toBe(true);
});

test.each([
  'https://notinstagram.com/p/ABC/', 'https://instagram.com.evil.test/p/ABC/',
  'https://evil.youtube.com/watch?v=abc', 'https://youtube.com.evil.test/watch?v=abc',
  'https://youtube.com./watch?v=abc', 'https://notiktok.com/@u/video/123',
  'https://evil.tiktok.com/@u/video/123', 'https://yоutube.com/watch?v=abc',
  'http://youtube.com/watch?v=abc', 'https://youtube.com:8443/watch?v=abc',
  'https://user:pass@youtube.com/watch?v=abc', 'https://youtube.com@evil.test/watch?v=abc',
  'https://youtube.com/redirect?q=https://evil.test',
  'https://youtube.com/attribution_link?u=/watch', '--config-location=/tmp/x',
  ' https://youtube.com/watch?v=abc', 'https://youtube.com\\@evil.test/watch?v=abc',
  null, {},
])('rejects unsafe/lookalike URL %s', url => {
  expect(classifyContentProvider(url)).toBeNull();
  expect(isYouTubeVideoUrl(url)).toBe(false);
});

test.each(['https://youtube.com/playlist?list=abc', 'https://youtube.com/@chef',
  'https://youtube.com/watch', 'https://youtu.be/', 'https://youtube.com/shorts/'])
('does not route non-video YouTube URL %s as a video', url => {
  expect(isYouTubeVideoUrl(url)).toBe(false);
});
