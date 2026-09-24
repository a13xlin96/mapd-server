'use strict';
const jobContext = require('../lib/jobContext');
const metrics = require('../lib/engineMetrics');

// Rates below are deliberately synthetic arithmetic fixtures, NOT vendor prices.
const prices = {schemaVersion: 1, asOf: '2026-09-14', currency: 'USD', rates: {
  model_fixture: {provider: 'anthropic', billing: 'tokens', usdPerMillion: {input: 2, output: 4, cacheRead: 1, cacheWrite: 3}},
  lookup_fixture: {provider: 'google', billing: 'calls', usdPerCall: .01},
}};
const tokens = {input: 1000, output: 500, cacheRead: 100, cacheWrite: 200};
function attempt({duration = 100, platform = 'instagram', language = 'en', queueMs = 10, call = true} = {}) {
  let now = 0;
  const m = metrics.createMetrics({prices, platform, language, queueMs, now: () => now});
  if (call) m.providerCall({provider: 'google', rateKey: 'lookup_fixture', outcome: 'success'});
  now = duration; return m.finish('success');
}
describe('bounded private engine metrics', () => {
  test('context-local collectors remain isolated across concurrent and nested jobs', async () => {
    expect(metrics.current()).toBeUndefined();
    expect(() => metrics.start()).toThrow('jobContext');
    const reports = await Promise.all(['instagram', 'tiktok'].map(platform => jobContext.run({jobId: `private-${platform}`, userId: 'private-user'}, async () => {
      const m = metrics.start({platform});
      await Promise.resolve();
      expect(metrics.current()).toBe(m);
      await jobContext.run({jobId: 'nested'}, async () => {
        expect(metrics.current()).toBeUndefined(); metrics.start({platform: 'web'});
      });
      expect(metrics.current()).toBe(m);
      expect(() => metrics.start()).toThrow('already');
      return m.finish();
    })));
    expect(reports.map(r => r.platform)).toEqual(['instagram', 'tiktok']);
    expect(metrics.current()).toBeUndefined();
  });
  test('copies only bounded allowlisted labels, booleans and numeric usage', async () => {
    const secret = 'https://private.example/caption?token=secret-user';
    const m = metrics.createMetrics({platform: secret, language: secret, featureVersion: secret, userId: secret, url: secret});
    m.evidence({caption: true, title: secret, privateText: secret});
    m.providerCall({provider: secret, rateKey: secret, stage: secret, tokens: {input: secret}, token: secret});
    m.cache(secret); m.operation(secret, 1);
    const error = Object.assign(new Error(secret), {code: 'rate_limited'});
    await expect(m.stage(secret, async () => {throw error;})).rejects.toBe(error);
    const report = m.finish(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.stages[0]).toMatchObject({stage: 'other', outcome: 'rate_limited'});
    expect(report.evidence).toEqual({caption: true});
    expect(report.estimatedCost.totalUsd).toBeNull();
  });
  test('limits event storage, preserves incompleteness, and freezes finalization', () => {
    const m = metrics.createMetrics({maxEvents: 2});
    for (let i = 0; i < 1000; i++) m.recordStage('ai', 10);
    const report = m.finish('partial');
    expect(report.stages).toHaveLength(2);
    expect(report.droppedEvents).toBe(998);
    expect(report.estimatedCost).toMatchObject({complete: false, totalUsd: null, reasons: ['dropped_events']});
    m.providerCall({}); report.stages.push({privateText: 'mutated'});
    expect(m.finish('failed').stages).toHaveLength(2);
    expect(m.finish().outcome).toBe('partial');
  });
  test('prices actual input, output and cache tokens; omitted usage stays unknown', () => {
    const m = metrics.createMetrics({prices});
    m.providerCall({provider: 'anthropic', rateKey: 'model_fixture', tokens});
    m.providerCall({provider: 'google', rateKey: 'lookup_fixture', outcome: 'success'});
    const cost = m.finish().estimatedCost;
    expect(cost.totalUsd).toBeCloseTo(.0147);
    expect(cost.complete).toBe(true);
    const unknown = metrics.createMetrics({prices});
    unknown.providerCall({provider: 'anthropic', rateKey: 'model_fixture', tokens: {input: 1000, output: 500}});
    expect(unknown.finish().estimatedCost).toMatchObject({totalUsd: null, complete: false, unknownCalls: 1, knownUsd: .004});
  });
  test('unknown rates/providers and unavailable cache prices cannot become free usage', () => {
    const m = metrics.createMetrics({prices});
    m.providerCall({provider: 'google', rateKey: 'model_fixture', tokens});
    m.providerCall({provider: 'google', rateKey: 'not_configured'});
    expect(m.finish().estimatedCost).toMatchObject({totalUsd: null, unknownCalls: 2});
    const table = JSON.parse(JSON.stringify(prices)); table.rates.model_fixture.usdPerMillion.cacheWrite = null;
    const paid = metrics.createMetrics({prices: table}); paid.providerCall({provider: 'anthropic', rateKey: 'model_fixture', tokens});
    expect(paid.finish().estimatedCost.complete).toBe(false);
    const zero = metrics.createMetrics({prices: table}); zero.providerCall({provider: 'anthropic', rateKey: 'model_fixture', tokens: {...tokens, cacheWrite: 0}});
    expect(zero.finish().estimatedCost.complete).toBe(true);
    const failed = metrics.createMetrics({prices}); failed.providerCall({provider: 'google', rateKey: 'lookup_fixture', outcome: 'failed'});
    expect(failed.finish().estimatedCost).toMatchObject({totalUsd: null, reasons: ['unknown_failed_call_billing']});
  });
  test('requires dated exact price table and explicit cache price categories', () => {
    expect(() => metrics.validatePrices({...prices, asOf: '2026-02-30'})).toThrow();
    expect(() => metrics.validatePrices({...prices, privateText: 'caption'})).toThrow();
    expect(() => metrics.validatePrices({...prices, rates: {bad: {provider: 'google', billing: 'calls', usdPerCall: -1}}})).toThrow();
    expect(() => metrics.validatePrices({...prices, rates: {bad: {provider: 'anthropic', billing: 'tokens', usdPerMillion: {input: 1, output: 1}}}})).toThrow();
  });
  test('private hook routes IDs separately, is repeatable by reportId, and propagates failure', async () => {
    await jobContext.run({jobId: 'sensitive-job', leaseOwner: 'sensitive-lease', userId: 'sensitive-user'}, async () => {
      metrics.start(); const hook = jest.fn();
      const report = await metrics.persistPrivate(hook, 'success');
      expect(hook.mock.calls[0][0]).toMatchObject({jobId: 'sensitive-job', leaseOwner: 'sensitive-lease', reportId: report.reportId});
      expect(JSON.stringify(report)).not.toContain('sensitive');
      const retry = await metrics.persistPrivate(hook, 'failed'); expect(retry).toEqual(report);
      await expect(metrics.persistPrivate(async () => {throw new Error('storage offline');})).rejects.toThrow('storage offline');
    });
  });
});
describe('aggregate reports', () => {
  test('percentiles, missing denominators, groups, stage/usage/ops coverage and unknown costs', () => {
    let now = 0; const m = metrics.createMetrics({prices, platform: 'instagram', language: 'ja', now: () => now});
    m.recordStage('source', 15, 'blocked'); m.cache('hit'); m.cache('miss');
    m.evidence({caption: true}); m.operation('lookupReads', 2);
    m.providerCall({provider: 'anthropic', rateKey: 'model_fixture', tokens});
    now = 200;
    const report = metrics.summarizeMetrics([attempt(), m.finish('blocked'), attempt({duration: 300, platform: 'tiktok'})]);
    expect(report.overall.processingMs).toMatchObject({p50: 200, p95: 300, observed: 3});
    expect(report.overall.queueMs).toMatchObject({observed: 2, missing: 1});
    expect(report.byPlatform.instagram.attempts).toBe(2);
    expect(report.byLanguage.ja.attempts).toBe(1);
    expect(report.overall.cache.hitRate).toMatchObject({numerator: 1, denominator: 2, value: .5});
    expect(report.overall.stages.source.durationMs.p95).toBe(15);
    expect(report.overall.providers.anthropic.tokens.input).toEqual({known: 1000, observedCalls: 1, unknownCalls: 0});
    expect(report.overall.operations.lookupReads.sum).toBe(2);
    expect(report.overall.evidence.caption.denominator).toBe(1);
    expect(report.overall.blockedSourceRate).toMatchObject({numerator: 1, denominator: 1});
    expect(report.overall.cost.perAttemptedLinkUsd).toBeNull();
    expect(report.quality).toBeNull();
    const unknown = metrics.createMetrics(); unknown.providerCall({provider: 'google'});
    expect(metrics.summarizeMetrics([attempt(), unknown.finish()]).overall.cost.totalUsd).toBeNull();
  });
  test('empty samples stay unknown and duplicate attempts fail', () => {
    expect(metrics.summarizeMetrics([]).overall.cost.totalUsd).toBeNull();
    expect(metrics.ratio(0, 0)).toEqual({numerator: 0, denominator: 0, value: null, ci95Wilson: null});
    const r = attempt(); expect(() => metrics.summarizeMetrics([r, r])).toThrow('duplicate');
    const interval = metrics.ratio(5, 10).ci95Wilson; expect(interval[0]).toBeCloseTo(.2366, 3); expect(interval[1]).toBeCloseTo(.7634, 3);
  });
  test('flags exact 10 percent changes, zero baselines and unknown costs honestly', () => {
    const baseline = metrics.summarizeMetrics([attempt({duration: 100})]);
    const comparison = metrics.compareAggregates(metrics.summarizeMetrics([attempt({duration: 110})]), baseline);
    expect(comparison.changes[0]).toMatchObject({relativeChange: .1, investigationRequired: true});
    const faster = metrics.compareAggregates(metrics.summarizeMetrics([attempt({duration: 90})]), baseline);
    expect(faster.changes[0]).toMatchObject({changeAtLeast10Percent: true, investigationRequired: false});
    const zero = metrics.compareAggregates(baseline, metrics.summarizeMetrics([attempt({duration: 0, call: false})]));
    expect(zero.changes[0]).toMatchObject({relativeChange: null, status: 'zero_baseline', investigationRequired: true});
  });
});
