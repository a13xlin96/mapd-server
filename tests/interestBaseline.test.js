const { summarizeInterestBaseline } = require('../functions/lib/interestBaseline');
const pin = (created, data) => ({ createTime: { toMillis: () => created }, data: () => data });

test('baseline reflects current pre-cutover inventory without inventing post-cutover history', () => {
  const result = summarizeInterestBaseline([
    pin(10, { category: 'food', city: 'Café', country: 'ES' }),
    pin(20, { category: 'food', city: 'Cafe\u0301', country: 'ES' }),
    pin(100, { category: 'bar', city: 'New', country: 'US' }),
    pin(NaN, { category: 'unknown' }),
  ], 100);
  expect(result).toMatchObject({ currentOwnedPinsBeforeCutover: 2, unknownCreationTime: 1,
    historyReconstructed: false, categories: { values: [{ value: 'food', count: 2 }] },
    cities: { values: [{ value: 'Café', count: 2 }] } });
  expect(result).not.toHaveProperty('verifiedPinSaves');
});

test('bounded summaries retain the denominator and treat arbitrary labels as data', () => {
  const result = summarizeInterestBaseline(Array.from({ length: 10000 }, (_, i) => pin(1, {
    category: i < 3 ? '__proto__' : `category-${i}`, city: `city-${i}`, country: 'x',
  })), 2);
  expect(result.categories.values).toHaveLength(64);
  expect(result.categories.values[0]).toEqual({ value: '__proto__', count: 3 });
  expect(result.categories.values.reduce((n, v) => n + v.count, result.categories.otherCount)).toBe(10000);
  expect(JSON.stringify(result).length).toBeLessThan(25000);
});
