// Pins the security wiring in lib/ytdlp.js itself (not just the pure
// isAllowedExtractUrl validator, covered separately in urlValidation.test.js).
// Without these, deleting the isAllowedExtractUrl guard or the '--'
// end-of-options separator in runYtDlp's spawn call would still pass the
// rest of the suite.
const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { spawn } = require('child_process');
const { runYtDlp } = require('../lib/ytdlp');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

beforeEach(() => {
  spawn.mockReset();
});

describe('runYtDlp security wiring', () => {
  test.each(['https://evil.youtube.com/watch?v=abc', 'https://evil.instagram.com/p/abc/',
    'https://notinstagram.com/p/abc/', 'https://tiktok.com.evil.test/@u/video/123',
    'https://evil.tiktok.com/@u/video/123'])('rejects noncanonical social host %s before spawning', async url => {
    await expect(runYtDlp(url)).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('rejects a non-allowlisted URL with INVALID_URL without spawning yt-dlp', async () => {
    await expect(runYtDlp('https://evil.example.com/x')).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('rejects an option-injection payload with INVALID_URL without spawning yt-dlp', async () => {
    await expect(runYtDlp('--config-location=/tmp/evil')).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('spawns yt-dlp with "--" immediately before the URL for an allowed URL', async () => {
    const url = 'https://www.tiktok.com/@chef/video/7300000000000000001';
    spawn.mockImplementation(() => {
      const proc = makeFakeProc();
      // Fail the process quickly so the promise settles and the test can
      // finish — this test only cares about the args spawn was called with.
      setImmediate(() => proc.emit('close', 1));
      return proc;
    });

    await runYtDlp(url).catch(() => {});

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('yt-dlp');
    const sepIndex = args.indexOf('--');
    expect(sepIndex).toBeGreaterThan(-1);
    expect(args[sepIndex + 1]).toBe(url);
  });
});
