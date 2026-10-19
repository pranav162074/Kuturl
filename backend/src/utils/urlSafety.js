// Checks a destination URL before it is stored. This file is pure, with no config, no
// database and no network, so it is cheap to test thoroughly.
//
// Kuturl never fetches the destination, so these rules are about abuse (phishing tricks,
// internal addresses, redirect loops), not about protecting our own server from requests.
// A public hostname can still resolve to a private address through DNS, which does not
// matter here because we never connect. If link previews were ever added, the address
// would have to be resolved and checked at connection time.

export const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;

const BLOCKED_SUFFIXES = new Set([
  'localhost',
  'local',
  'internal',
  'localdomain',
  'lan',
  'intranet',
  'corp',
  'home',
  'private',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const fail = (message) => ({ ok: false, message });

const PRIVATE_MESSAGE = 'Links to private or internal addresses are not allowed';

const isPrivateIPv4 = ([a, b, c]) =>
  a === 0 || // "this network"
  a === 10 || // private
  a === 127 || // loopback
  (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
  (a === 169 && b === 254) || // link-local, includes the cloud metadata address
  (a === 172 && b >= 16 && b <= 31) || // private
  (a === 192 && b === 0 && c === 0) || // protocol assignments
  (a === 192 && b === 0 && c === 2) || // documentation
  (a === 192 && b === 168) || // private
  (a === 198 && (b === 18 || b === 19)) || // benchmarking
  (a === 198 && b === 51 && c === 100) || // documentation
  (a === 203 && b === 0 && c === 113) || // documentation
  a >= 224; // multicast and reserved, including 255.255.255.255

// Turns "2001:db8::1" into eight numbers. Returns null if the text is not valid IPv6.
const parseIPv6 = (text) => {
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const split = (part) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];

  let groups;
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;

  const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
};

// Allow-list, not block-list: only global unicast addresses (2000::/3) pass. That alone
// rules out loopback, unspecified, link-local, unique-local, multicast, IPv4-mapped and
// NAT64 addresses. The few special ranges inside 2000::/3 are removed below.
const isPublicIPv6 = (groups) => {
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0x0000)) return false; // documentation, Teredo
  if (groups[0] === 0x2002) return false; // 6to4 embeds an IPv4 address
  return true;
};

const hasBlockedSuffix = (host) => {
  if (host === 'home.arpa' || host.endsWith('.home.arpa')) return true;
  return BLOCKED_SUFFIXES.has(host.slice(host.lastIndexOf('.') + 1));
};

// Returns an error message, or null if the host is acceptable
export const checkHostname = (rawHost) => {
  // IPv6 addresses arrive in brackets, already normalised by the URL parser
  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    const groups = parseIPv6(rawHost.slice(1, -1));
    return groups && isPublicIPv6(groups) ? null : PRIVATE_MESSAGE;
  }

  const host = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;

  if (IPV4.test(host)) {
    return isPrivateIPv4(host.split('.').map(Number)) ? PRIVATE_MESSAGE : null;
  }

  if (host.length > MAX_HOST_LENGTH) return 'The URL host is too long';
  if (!host.includes('.')) return PRIVATE_MESSAGE; // single-label names like "intranet"
  if (hasBlockedSuffix(host)) return PRIVATE_MESSAGE;
  return null;
};

const hasForbiddenCharacters = (text) => {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true; // spaces and control characters
  }
  return false;
};

// Returns { ok: true, url } with the normalised URL, or { ok: false, message }.
// ownHost is the hostname Kuturl itself runs on, so its links can't be shortened again.
export const validateLongUrl = (input, { ownHost } = {}) => {
  const text = String(input).trim();

  if (text.length === 0) return fail('URL is required');
  if (text.length > MAX_URL_LENGTH) return fail(`URL must be at most ${MAX_URL_LENGTH} characters`);
  if (hasForbiddenCharacters(text)) return fail('URL must not contain spaces or control characters');

  let url;
  try {
    url = new URL(text);
  } catch {
    return fail('Enter a full URL starting with http:// or https://');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('Only http and https URLs can be shortened');
  }

  // "https://paypal.com@evil.com" really goes to evil.com. Nobody needs credentials in a link.
  if (url.username || url.password) return fail('URLs with a username or password are not allowed');

  const problem = checkHostname(url.hostname);
  if (problem) return fail(problem);

  if (ownHost && url.hostname === ownHost) return fail('Kuturl links cannot be shortened again');

  // Normalising can lengthen a URL (for example by percent-encoding), so check again
  if (url.href.length > MAX_URL_LENGTH) return fail(`URL must be at most ${MAX_URL_LENGTH} characters`);

  return { ok: true, url: url.href };
};