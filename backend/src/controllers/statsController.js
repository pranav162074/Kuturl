import { getLink } from '../services/links.js';
import { isValidCodeShape } from '../utils/codeFormat.js';
import { DEVICES } from '../utils/device.js';
import { linkTotals, clickSeries, topReferrers, deviceCounts } from '../db/stats.js';

const HOUR_MS = 60 * 60 * 1000;

const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Link not found' });

const ownedLink = async (req, res) => {
  const { code } = req.params;
  const link = isValidCodeShape(code) ? await getLink(code, req.apiKey.id) : null;
  if (!link) notFound(res);
  return link;
};

const hoursBack = (now, hours) => new Date(Math.floor(now / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS);

export const statsSummaryHandler = async (req, res) => {
  const link = await ownedLink(req, res);
  if (!link) return;

  const now = Date.now();
  const totals = await linkTotals(link.id, {
    since24h: hoursBack(now, 24),
    since7d: hoursBack(now, 7 * 24),
    since30d: hoursBack(now, 30 * 24),
  });

  res.json({
    code: link.code,
    totalClicks: totals.total,
    last24Hours: totals.last24,
    last7Days: totals.last7,
    last30Days: totals.last30,
    lastClickAt: totals.lastClickAt,
    timezone: 'UTC',
  });
};

export const statsSeriesHandler = async (req, res) => {
  const link = await ownedLink(req, res);
  if (!link) return;

  const { interval, from, to } = res.locals.query;
  const points = await clickSeries(link.id, { interval, from, to });

  res.json({
    code: link.code,
    interval,
    from,
    to,
    timezone: 'UTC',
    totalClicks: points.reduce((sum, point) => sum + point.clicks, 0),
    points,
  });
};

export const statsReferrersHandler = async (req, res) => {
  const link = await ownedLink(req, res);
  if (!link) return;

  const { from, to, limit } = res.locals.query;
  res.json({ code: link.code, from, to, referrers: await topReferrers(link.id, { from, to, limit }) });
};

export const statsDevicesHandler = async (req, res) => {
  const link = await ownedLink(req, res);
  if (!link) return;

  const { from, to } = res.locals.query;
  const counts = await deviceCounts(link.id, { from, to });
  const devices = Object.fromEntries(DEVICES.map((device) => [device, counts[device] ?? 0]));

  res.json({
    code: link.code,
    from,
    to,
    totalClicks: Object.values(devices).reduce((sum, clicks) => sum + clicks, 0),
    devices,
  });
};
