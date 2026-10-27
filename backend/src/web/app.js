'use strict';

const KEY_STORAGE = 'kuturl.apiKey';
const STATUS_LABELS = {
  active: 'Active',
  disabled: 'Disabled',
  expired: 'Expired',
  click_limit_reached: 'Click limit reached',
};
const DEVICE_LABELS = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', bot: 'Bots', other: 'Other' };

const $ = (id) => document.getElementById(id);

const memory = {};
const storage = {
  get: () => {
    try {
      return window.localStorage.getItem(KEY_STORAGE) ?? memory.key ?? null;
    } catch {
      return memory.key ?? null;
    }
  },
  set: (value) => {
    memory.key = value;
    try {
      window.localStorage.setItem(KEY_STORAGE, value);
      return true;
    } catch {
      return false;
    }
  },
  clear: () => {
    delete memory.key;
    try {
      window.localStorage.removeItem(KEY_STORAGE);
    } catch {
      return;
    }
  },
};

class ApiError extends Error {
  constructor(status, body, retryAfter) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

const randomId = () => {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const request = async (method, path, { body, key = storage.get(), headers = {}, raw = false } = {}) => {
  const res = await fetch(path, {
    method,
    headers: {
      ...(key && { Authorization: `Bearer ${key}` }),
      ...(body && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  if (raw && res.ok) return res;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data, Number(res.headers.get('Retry-After')) || null);
  return data;
};

const waitText = (seconds) => {
  if (!seconds) return 'a little while';
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
};

const describeError = (error) => {
  if (!(error instanceof ApiError)) return 'Could not reach Kuturl. Check your connection and try again.';
  if (error.status === 429) return `Too many requests. Try again in ${waitText(error.retryAfter)}.`;
  if (error.body?.details?.length) return error.body.details.map((detail) => detail.message).join('. ');
  return error.message;
};

const show = (element, text) => {
  element.textContent = text;
  element.hidden = !text;
};

const setStatus = (text, isError = false) => {
  const status = $('status');
  show(status, text);
  status.classList.toggle('error', isError);
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

const shortHost = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

const copyText = async (text, button) => {
  let done;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      done = document.execCommand('copy');
    } catch {
      done = false;
    }
    area.remove();
  }
  if (button) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = done ? 'Copied' : 'Copy failed';
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  }
};

const confirmTwice = (button, prompt, action) => {
  if (button.dataset.armed === 'true') {
    button.dataset.armed = 'false';
    button.textContent = button.dataset.label;
    clearTimeout(Number(button.dataset.timer));
    action();
    return;
  }
  button.dataset.label = button.dataset.label || button.textContent;
  button.dataset.armed = 'true';
  button.textContent = prompt;
  button.dataset.timer = String(
    setTimeout(() => {
      button.dataset.armed = 'false';
      button.textContent = button.dataset.label;
    }, 4000)
  );
};

const cell = (text, className) => {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
};

const keyLost = () => {
  storage.clear();
  renderKey();
  renderLinks([], false);
  closeDetails();
  setStatus('The key this browser was using no longer works, so its links can no longer be shown here. A new key will be made when you shorten your next link.', true);
};

const guarded = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && storage.get()) keyLost();
    throw error;
  }
};

const ensureKey = async () => {
  const existing = storage.get();
  if (existing) return existing;
  try {
    const created = await request('POST', '/api/v1/keys', { body: { name: 'Web page' }, key: null });
    const kept = storage.set(created.apiKey);
    if (!kept) setStatus('This browser is not saving data for this site, so your links will disappear when you close the page. Copy your key from "Your key" to keep them.', true);
    renderKey();
    return created.apiKey;
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      throw new ApiError(429, { message: `Too many keys were made from your network recently. Try again in ${waitText(error.retryAfter)}, or paste an existing key under "Your key".` });
    }
    throw error;
  }
};

const buildLinkBody = () => {
  const body = { url: $('url').value.trim() };
  const alias = $('alias').value.trim();
  const expires = $('expires').value;
  const password = $('password').value;
  const maxClicks = $('max-clicks').value.trim();
  if (alias) body.alias = alias;
  if (expires) {
    const date = new Date(expires);
    if (Number.isNaN(date.getTime())) throw new Error('Expiry date is not valid.');
    body.expiresAt = date.toISOString();
  }
  if (password) body.password = password;
  if (maxClicks) {
    const number = Number(maxClicks);
    if (!Number.isInteger(number) || number < 1) throw new Error('Click limit must be a whole number, 1 or more.');
    body.maxClicks = number;
  }
  return body;
};

let lastCreated = null;

const onShorten = async (event) => {
  event.preventDefault();
  const button = $('shorten-button');
  show($('shorten-error'), '');
  if (!$('url').value.trim()) {
    show($('shorten-error'), 'Paste a URL to shorten.');
    $('url').focus();
    return;
  }

  let body;
  try {
    body = buildLinkBody();
  } catch (error) {
    show($('shorten-error'), error.message);
    return;
  }

  button.disabled = true;
  button.textContent = 'Shortening...';
  try {
    await ensureKey();
    const link = await guarded(() =>
      request('POST', '/api/v1/links', { body, headers: { 'Idempotency-Key': randomId() } })
    );
    lastCreated = link;
    $('result-link').textContent = link.shortUrl;
    $('result-link').href = link.shortUrl;
    $('result-target').textContent = link.longUrl;
    $('result').hidden = false;
    $('shorten').reset();
    $('options').open = false;
    setStatus('');
    loadLinks();
  } catch (error) {
    show($('shorten-error'), describeError(error));
  } finally {
    button.disabled = false;
    button.textContent = 'Shorten';
  }
};

let nextCursor = null;
let loadingLinks = false;

const fillClicks = async (rows) => {
  const queue = [...rows];
  const run = async () => {
    while (queue.length > 0) {
      const { code, target } = queue.shift();
      try {
        const stats = await request('GET', `/api/v1/links/${encodeURIComponent(code)}/stats`);
        target.textContent = stats.totalClicks.toLocaleString();
      } catch {
        target.textContent = '?';
      }
    }
  };
  await Promise.all([run(), run(), run(), run()]);
};

const renderLinks = (links, append) => {
  const body = $('links-body');
  if (!append) body.replaceChildren();
  const pending = [];
  for (const link of links) {
    const row = document.createElement('tr');

    const first = document.createElement('td');
    const open = document.createElement('a');
    open.href = '#details';
    open.textContent = link.code;
    open.title = 'Show details';
    open.addEventListener('click', (event) => {
      event.preventDefault();
      openDetails(link.code);
    });
    first.appendChild(open);

    const target = cell(shortHost(link.longUrl));
    target.title = link.longUrl;
    const clicks = cell('...', 'num');
    const status = cell(STATUS_LABELS[link.status] || link.status, link.status === 'active' ? 'status-active' : 'status-off');

    row.append(first, target, clicks, cell(formatDate(link.createdAt)), status);
    body.appendChild(row);
    pending.push({ code: link.code, target: clicks });
  }
  $('links').hidden = body.children.length === 0;
  $('links-empty').hidden = body.children.length > 0;
  return pending;
};

const loadLinks = async (append = false) => {
  if (loadingLinks) return;
  if (!storage.get()) {
    renderLinks([], false);
    $('more').hidden = true;
    return;
  }
  loadingLinks = true;
  try {
    const query = new URLSearchParams({ limit: '20' });
    if (append && nextCursor) query.set('cursor', nextCursor);
    const page = await guarded(() => request('GET', `/api/v1/links?${query}`));
    nextCursor = page.nextCursor;
    const pending = renderLinks(page.links, append);
    $('more').hidden = !nextCursor;
    fillClicks(pending);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) setStatus(`Could not load your links. ${describeError(error)}`, true);
  } finally {
    loadingLinks = false;
  }
};

let current = null;

const toDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const renderChart = (series) => {
  const chart = $('d-chart');
  chart.replaceChildren();
  const points = series.points;
  const highest = Math.max(1, ...points.map((point) => point.clicks));
  const label = (point) => new Date(point.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  for (const point of points) {
    const bar = document.createElement('div');
    bar.className = point.clicks === 0 ? 'bar-day zero' : 'bar-day';
    bar.style.height = `${point.clicks === 0 ? 1 : Math.max(3, (point.clicks / highest) * 100)}%`;
    bar.title = `${label(point)}: ${point.clicks} click${point.clicks === 1 ? '' : 's'}`;
    chart.appendChild(bar);
  }
  $('d-axis-start').textContent = points.length ? label(points[0]) : '';
  $('d-axis-end').textContent = points.length ? `${label(points[points.length - 1])}, busiest day ${highest}` : '';
};

const renderRows = (tbody, rows, emptyText) => {
  tbody.replaceChildren();
  if (rows.length === 0) {
    const row = document.createElement('tr');
    const td = cell(emptyText, 'muted');
    td.colSpan = 2;
    row.appendChild(td);
    tbody.appendChild(row);
    return;
  }
  for (const [name, clicks] of rows) {
    const row = document.createElement('tr');
    row.append(cell(name), cell(clicks.toLocaleString(), 'num'));
    tbody.appendChild(row);
  }
};

const renderLink = (link) => {
  current = link;
  $('d-code').textContent = link.code;
  $('d-short').textContent = link.shortUrl;
  $('d-short').href = link.shortUrl;
  $('d-long').textContent = link.longUrl;
  $('d-status').textContent = STATUS_LABELS[link.status] || link.status;
  $('d-status').className = link.status === 'active' ? 'status-active' : 'status-off';
  $('d-created').textContent = formatDate(link.createdAt);
  $('d-expires').textContent = link.expiresAt ? formatDate(link.expiresAt) : 'Never';
  $('d-limit').textContent = link.maxClicks ? `${link.maxClicks.toLocaleString()} clicks` : 'None';
  $('d-password').textContent = link.passwordProtected ? 'Yes' : 'No';
  $('d-toggle').textContent = link.disabledAt ? 'Enable link' : 'Disable link';
};

const openDetails = async (code) => {
  show($('d-error'), '');
  $('details').hidden = false;
  $('d-code').textContent = code;
  $('details').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const base = `/api/v1/links/${encodeURIComponent(code)}`;

  try {
    const [link, stats, series, referrers, devices] = await guarded(() =>
      Promise.all([
        request('GET', base),
        request('GET', `${base}/stats`),
        request('GET', `${base}/stats/timeseries?interval=day`),
        request('GET', `${base}/stats/referrers?limit=10`),
        request('GET', `${base}/stats/devices`),
      ])
    );
    renderLink(link);
    $('d-total').textContent = stats.totalClicks.toLocaleString();
    $('d-24h').textContent = stats.last24Hours.toLocaleString();
    $('d-7d').textContent = stats.last7Days.toLocaleString();
    $('d-30d').textContent = stats.last30Days.toLocaleString();
    renderChart(series);
    renderRows($('d-referrers'), referrers.referrers.map((item) => [item.host || 'Direct or unknown', item.clicks]), 'No clicks yet');
    renderRows(
      $('d-devices'),
      Object.entries(devices.devices).filter(([, clicks]) => clicks > 0).map(([name, clicks]) => [DEVICE_LABELS[name] || name, clicks]),
      'No clicks yet'
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      closeDetails();
      setStatus('That link no longer exists.', true);
      loadLinks();
      return;
    }
    show($('d-error'), describeError(error));
    return;
  }

  try {
    const [png, svg] = await Promise.all([
      request('GET', `${base}/qr?format=png&size=512`, { raw: true }).then((res) => res.blob()).then(toDataUrl),
      request('GET', `${base}/qr?format=svg`, { raw: true }).then((res) => res.text()),
    ]);
    $('d-qr').src = png;
    $('d-qr-png').href = png;
    $('d-qr-png').download = `kuturl-${code}.png`;
    $('d-qr-svg').href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    $('d-qr-svg').download = `kuturl-${code}.svg`;
  } catch {
    $('d-qr').removeAttribute('src');
  }
};

const closeDetails = () => {
  current = null;
  $('details').hidden = true;
};

const onToggle = async () => {
  if (!current) return;
  const button = $('d-toggle');
  button.disabled = true;
  show($('d-error'), '');
  try {
    const link = await guarded(() =>
      request('PATCH', `/api/v1/links/${encodeURIComponent(current.code)}`, { body: { disabled: !current.disabledAt } })
    );
    renderLink(link);
    loadLinks();
  } catch (error) {
    show($('d-error'), describeError(error));
  } finally {
    button.disabled = false;
  }
};

const onDelete = () => {
  if (!current) return;
  confirmTwice($('d-delete'), 'Click again to delete', async () => {
    show($('d-error'), '');
    try {
      await guarded(() => request('DELETE', `/api/v1/links/${encodeURIComponent(current.code)}`));
      if (lastCreated?.code === current.code) $('result').hidden = true;
      closeDetails();
      loadLinks();
    } catch (error) {
      show($('d-error'), describeError(error));
    }
  });
};

const renderKey = () => {
  const key = storage.get();
  $('key-prefix').textContent = key ? `${key.slice(0, 8)}...` : 'none yet';
  $('key-copy').disabled = !key;
  $('key-forget').disabled = !key;
};

const onUseKey = async (event) => {
  event.preventDefault();
  const key = $('key-input').value.trim();
  show($('key-error'), '');
  if (!/^kt_[A-Za-z0-9_-]{8,}$/.test(key)) {
    show($('key-error'), 'That does not look like a Kuturl key. Keys start with kt_.');
    return;
  }
  try {
    await request('GET', '/api/v1/keys/me', { key });
  } catch (error) {
    show($('key-error'), error instanceof ApiError && error.status === 401 ? 'That key is not valid or has been revoked.' : describeError(error));
    return;
  }
  storage.set(key);
  $('key-input').value = '';
  $('result').hidden = true;
  closeDetails();
  setStatus('');
  renderKey();
  loadLinks();
};

const onForget = () => {
  confirmTwice($('key-forget'), 'Click again to forget', () => {
    storage.clear();
    $('result').hidden = true;
    closeDetails();
    renderKey();
    loadLinks();
    setStatus('This browser has forgotten the key. Your links still exist, and the key still works anywhere you saved it.');
  });
};

document.addEventListener('DOMContentLoaded', () => {
  $('shorten').addEventListener('submit', onShorten);
  $('result-copy').addEventListener('click', (event) => copyText($('result-link').textContent, event.currentTarget));
  $('result-details').addEventListener('click', () => lastCreated && openDetails(lastCreated.code));
  $('d-close').addEventListener('click', closeDetails);
  $('d-copy').addEventListener('click', (event) => copyText($('d-short').textContent, event.currentTarget));
  $('d-toggle').addEventListener('click', onToggle);
  $('d-delete').addEventListener('click', onDelete);
  $('refresh').addEventListener('click', () => loadLinks());
  $('more').addEventListener('click', () => loadLinks(true));
  $('key-copy').addEventListener('click', (event) => {
    const key = storage.get();
    if (key) copyText(key, event.currentTarget);
  });
  $('key-forget').addEventListener('click', onForget);
  $('key-form').addEventListener('submit', onUseKey);
  renderKey();
  loadLinks();
});
