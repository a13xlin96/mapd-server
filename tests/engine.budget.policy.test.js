const {
  DEFAULT_POLICY, DEFAULT_PRICES, validatePolicy, validatePrices, ceilingFor,
  priceTokens, prospectiveAllowance, priorDayRisk,
} = require('../lib/engineBudget');

const copy = value => JSON.parse(JSON.stringify(value));
const empty = () => ({physicalCalls: 0, knownActualMicrodollars: 0, uncertainLiabilityMicrodollars: 0,
  unknownLiabilityCalls: 0, priorDayRiskMicrodollars: 0, priorDayUnknownLiabilityCalls: 0});
const state = () => ({attempt: empty(), accountDay: empty(), globalDay: empty()});

describe('budget schemas and prospective-only calculations', () => {
  test('launch defaults activate no limits, stop, or enforcement', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.mode).toBe('observe');
    expect(DEFAULT_POLICY.emergencyStop).toBe(false);
    expect(Object.values(DEFAULT_POLICY.limits)).toEqual([null, null, null, null]);
    expect(Object.isFrozen(DEFAULT_POLICY.limits)).toBe(true);
    expect(validatePrices(DEFAULT_PRICES)).toEqual(DEFAULT_PRICES);
  });

  test.each([null, {}, {mode: 'enforce'}, {...DEFAULT_POLICY, extra: true},
    {...DEFAULT_POLICY, emergencyStop: 'false'}, {...DEFAULT_POLICY, limits: {}},
    ...[-1, 1.5, '100', Infinity, Number.MAX_SAFE_INTEGER + 1].map(attemptMicrodollars =>
      ({...DEFAULT_POLICY, limits: {...DEFAULT_POLICY.limits, attemptMicrodollars}})),
  ])('rejects malformed policy for offline validation: %j', policy => {
    expect(() => validatePolicy(policy)).toThrow();
  });

  test('future policy accepts integer caps but is copied and has no side effects', () => {
    const policy = {...DEFAULT_POLICY, mode: 'enforce', limits: {...DEFAULT_POLICY.limits, attemptMicrodollars: 0}};
    const valid = validatePolicy(policy);
    valid.limits.attemptMicrodollars = 100;
    expect(policy.limits.attemptMicrodollars).toBe(0);
  });

  test.each([
    prices => { prices.asOf = '2026-02-30'; },
    prices => { prices.validThrough = '2026-09-17'; },
    prices => { prices.rates.places_search.microdollarsPerCall = 0.1; },
    prices => { delete prices.rates.haiku.microdollarsPerMillion.cacheWrite; },
    prices => { prices.rates.haiku.microdollarsPerMillion.output = -1; },
    prices => { prices.rates.haiku.usdPerMillion = {input: 1}; },
  ])('rejects malformed/ambiguous prices', change => {
    const prices = copy(DEFAULT_PRICES); change(prices);
    expect(() => validatePrices(prices)).toThrow();
  });

  test('audit rates use integer microdollars and never assume unknown cache tokens are free', () => {
    expect(ceilingFor(DEFAULT_PRICES.rates.places_search, {})).toBe(32000);
    expect(ceilingFor(DEFAULT_PRICES.rates.places_details, {})).toBe(25000);
    expect(ceilingFor(DEFAULT_PRICES.rates.haiku,
      {maxInputTokens: 1000, maxImageTokens: 2000, maxOutputTokens: 400, cacheEnabled: false})).toBe(5000);
    expect(ceilingFor(DEFAULT_PRICES.rates.haiku,
      {maxInputTokens: 1000, maxImageTokens: 0, maxOutputTokens: 400})).toBeNull();
    expect(ceilingFor(null, {})).toBeNull();
    expect(priceTokens({input: 10, output: 10, cacheRead: 2, cacheWrite: 0}, DEFAULT_PRICES.rates.haiku))
      .toMatchObject({knownMicrodollars: 60, complete: false});
  });

  test('ceil rounding is exact and overflow cannot become an apparently complete zero price', () => {
    const rate = {microdollarsPerMillion: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0}};
    expect(priceTokens({input: 1, output: 1, cacheRead: 0, cacheWrite: 0}, rate))
      .toEqual({knownMicrodollars: 1, complete: true, overflow: false});
    rate.microdollarsPerMillion.input = Number.MAX_SAFE_INTEGER;
    expect(priceTokens({input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0}, rate))
      .toEqual({knownMicrodollars: 0, complete: false, overflow: true});
  });

  test('prospective exact-limit acceptance includes outstanding and prior-day liability once', () => {
    const s = state();
    Object.assign(s.globalDay, {knownActualMicrodollars: 10, uncertainLiabilityMicrodollars: 20, priorDayRiskMicrodollars: 30});
    const policy = {...DEFAULT_POLICY, limits: {...DEFAULT_POLICY.limits, globalDayMicrodollars: 100}};
    expect(prospectiveAllowance({policy, ceilingMicrodollars: 40, state: s})).toEqual({allowed: true, reason: null, prospectiveOnly: true});
    expect(prospectiveAllowance({policy, ceilingMicrodollars: 41, state: s})).toMatchObject({allowed: false, reason: 'globalDayMicrodollars'});
  });

  test.each(['attemptCalls', 'attemptMicrodollars', 'accountDayMicrodollars', 'globalDayMicrodollars'])
    ('prospective %s checks are independent from runtime', key => {
      const policy = {...DEFAULT_POLICY, limits: {...DEFAULT_POLICY.limits, [key]: 0}};
      expect(prospectiveAllowance({policy, ceilingMicrodollars: 1, state: state()}).allowed).toBe(false);
    });

  test('prospective missing data, unknown price/risk, emergency stop cannot permit an enforced reservation', () => {
    const input = {policy: DEFAULT_POLICY, ceilingMicrodollars: 1, state: state()};
    expect(prospectiveAllowance({...input, policy: null}).reason).toBe('invalid_policy');
    expect(prospectiveAllowance({...input, ceilingMicrodollars: null}).reason).toBe('unknown_charge');
    expect(prospectiveAllowance({...input, state: {}}).reason).toBe('unknown_spend');
    expect(prospectiveAllowance({...input, policy: {...DEFAULT_POLICY, emergencyStop: true}}).reason).toBe('emergency_stop');
    input.state.accountDay.priorDayUnknownLiabilityCalls = 1;
    expect(prospectiveAllowance(input).reason).toBe('unknown_liability');
  });

  test('risk hold is unresolved lifetime less today, independent of historical settled costs', () => {
    expect(priorDayRisk({uncertainLiabilityMicrodollars: 100, unknownLiabilityCalls: 3},
      {uncertainLiabilityMicrodollars: 40, unknownLiabilityCalls: 1}))
      .toEqual({priorDayRiskMicrodollars: 60, priorDayUnknownLiabilityCalls: 2});
    expect(() => priorDayRisk({uncertainLiabilityMicrodollars: 1}, {uncertainLiabilityMicrodollars: 2})).toThrow();
  });
});
