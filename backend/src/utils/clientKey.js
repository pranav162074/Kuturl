import { parseIPv6 } from './urlSafety.js';

// Turns a client address into the key its rate limit bucket is stored under.
// - IPv4 addresses are used as they are.
// - An IPv4 address wrapped in IPv6 (::ffff:1.2.3.4) is unwrapped, so it shares a bucket
//   with the same client connecting over IPv4.
// - IPv6 addresses are grouped by their first 64 bits. One user typically controls a whole
//   /64 (billions of addresses), so limiting per full address would be no limit at all.
export const clientKey = (ip) => {
  if (typeof ip !== 'string' || ip === '') return 'unknown';

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;

  const groups = parseIPv6(ip.split('%')[0]); // drop an interface suffix such as %eth0
  if (!groups) return ip;
  return `v6:${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}`;
};