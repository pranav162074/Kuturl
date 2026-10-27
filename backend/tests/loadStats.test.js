import { describe, it, expect } from 'vitest';
import { percentile, summarize, problemsWith, toMarkdown } from '../scripts/load/stats.js';

describe('load test statistics', () => {
  it('uses the nearest-rank percentile', () => {
    const sorted = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile(Float64Array.from([7]), 95)).toBe(7);
    expect(percentile(new Float64Array(0), 95)).toBeNull();
  });

  it('sorts times numerically, not as text', () => {
    const result = summarize({ name: 'x', times: [100, 9, 20, 3], statuses: { 200: 4 }, expected: [200], durationSeconds: 1 });
    expect(result.p50).toBe(9);
    expect(result.max).toBe(100);
  });

  it('counts responses with a status the scenario did not expect', () => {
    const result = summarize({
      name: 'redirects',
      times: [1, 2, 3, 4],
      statuses: { 302: 2, 404: 1, 500: 1 },
      expected: [302, 404],
      durationSeconds: 2,
      queries: 6,
    });
    expect(result).toMatchObject({ requests: 4, perSecond: 2, unexpected: 1, queriesPerRequest: 1.5 });
    expect(problemsWith(result)).toEqual(['1 responses with an unexpected status']);
  });

  it('fails a scenario that completed nothing, or hit errors or timeouts', () => {
    const empty = summarize({ name: 'x', times: [], statuses: {}, expected: [200], durationSeconds: 1, errors: 2, timeouts: 1 });
    expect(problemsWith(empty)).toEqual(['no requests completed', '2 connection errors', '1 timeouts']);
    expect(empty.p95).toBeNull();
    expect(empty.queriesPerRequest).toBeNull();
  });

  it('prints a markdown table with one row per scenario', () => {
    const result = summarize({ name: 'Redirect', times: [1.04, 2.5], statuses: { 302: 2 }, expected: [302], durationSeconds: 1, queries: 0 });
    const markdown = toMarkdown([result], { connections: 50, durationSeconds: 1, node: '22.0.0', cpus: 4 });
    expect(markdown).toContain('50 connections, 1 s per scenario, Node 22.0.0, 4 CPUs.');
    expect(markdown).toContain('| Redirect | 2 | 1.0 ms | 2.5 ms | 2.5 ms | 0.00 | 0 |');
  });
});
