export const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

export const summarize = ({ name, times, statuses, expected, durationSeconds, errors = 0, timeouts = 0, queries = null }) => {
  const sorted = Float64Array.from(times).sort();
  const total = sorted.length;
  const unexpected = Object.entries(statuses)
    .filter(([status]) => !expected.includes(Number(status)))
    .reduce((sum, [, count]) => sum + count, 0);
  const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
  return {
    name,
    requests: total,
    perSecond: Math.round(total / durationSeconds),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(total ? sorted[total - 1] : null),
    queriesPerRequest: queries === null || total === 0 ? null : round(queries / total),
    statuses,
    unexpected,
    errors,
    timeouts,
  };
};

export const problemsWith = (result) => {
  const problems = [];
  if (result.requests === 0) problems.push('no requests completed');
  if (result.unexpected > 0) problems.push(`${result.unexpected} responses with an unexpected status`);
  if (result.errors > 0) problems.push(`${result.errors} connection errors`);
  if (result.timeouts > 0) problems.push(`${result.timeouts} timeouts`);
  return problems;
};

const cellMs = (value) => (value === null ? '-' : `${value.toFixed(1)} ms`);

export const toMarkdown = (results, { connections, durationSeconds, node, cpus }) => {
  const lines = [
    `| Scenario | Requests/s | p50 | p95 | p99 | DB transactions per request | Unexpected |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.perSecond.toLocaleString('en-US')} | ${cellMs(result.p50)} | ${cellMs(result.p95)} | ${cellMs(result.p99)} | ${result.queriesPerRequest === null ? '-' : result.queriesPerRequest.toFixed(2)} | ${result.unexpected + result.errors + result.timeouts} |`
    ),
  ];
  return [
    `${connections} connections, ${durationSeconds} s per scenario, Node ${node}, ${cpus} CPUs.`,
    '',
    ...lines,
  ].join('\n');
};
