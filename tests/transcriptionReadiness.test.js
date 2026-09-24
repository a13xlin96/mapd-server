const {transcriptionReadiness} = require('../lib/transcriptionReadiness');

test('startup readiness does not dispatch paid work or claim model access', () => {
  const fetchSpy = jest.spyOn(global, 'fetch');
  try {
    expect(transcriptionReadiness({})).toEqual({
      event: 'transcription_readiness', apiKeyConfigured: false,
      model: 'gpt-4o-mini-transcribe-2025-12-15', modelAccess: 'not_tested',
      mediaEnrollment: 'off',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

test('key presence does not enable media and diagnostics contain no secret values', () => {
  const env = {OPENAI_API_KEY: 'test-secret-never-log-this', OTHER_SECRET: 'also-private'};
  const result = transcriptionReadiness(env);
  expect(result).toMatchObject({apiKeyConfigured: true, mediaEnrollment: 'off'});
  expect(JSON.stringify(result)).not.toContain(env.OPENAI_API_KEY);
  expect(JSON.stringify(result)).not.toContain(env.OTHER_SECRET);
  expect(env).toEqual({OPENAI_API_KEY: 'test-secret-never-log-this', OTHER_SECRET: 'also-private'});
});

test('reports configured enrollment without disclosing private cohort IDs', () => {
  const config = {snapshotVersion: 2, internalUids: ['private-account'], flags: {mediaEvidence: true}};
  const result = transcriptionReadiness({ENGINE_ROLLOUT_JSON: JSON.stringify(config)});
  expect(result.mediaEnrollment).toBe('configured');
  expect(JSON.stringify(result)).not.toContain('private-account');
});

test.each([' ', '{private-secret', 'null', '{"flags":{"mediaEvidence":true}}'])('bad rollout config is reported without echoing it', raw => {
  expect(transcriptionReadiness({ENGINE_ROLLOUT_JSON: raw})).toMatchObject({mediaEnrollment: 'invalid_config'});
});

test('blank or non-string keys are not configured', () => {
  for (const value of ['', '  ', undefined, null, 123]) {
    expect(transcriptionReadiness({OPENAI_API_KEY: value}).apiKeyConfigured).toBe(false);
  }
});
