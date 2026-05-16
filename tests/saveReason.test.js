const { assertSaveReason, VALID } = require('../lib/saveReason');

describe('assertSaveReason', () => {
  test.each(VALID)('accepts valid saveReason %s', (reason) => {
    expect(() => assertSaveReason(reason)).not.toThrow();
  });

  test.each([
    null,
    undefined,
    '',
    'MANUAL',
    'shareExtension',
    'auto',
    42,
    {},
    [],
    true,
  ])('rejects invalid saveReason %p', (value) => {
    expect(() => assertSaveReason(value)).toThrow(/Invalid saveReason/);
  });

  test('VALID list is exactly the three Phase 1 values', () => {
    expect(VALID).toEqual(['manual', 'clone', 'enrichment']);
  });
});
