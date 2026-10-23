const BOT = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|curl\/|wget\/|python-requests|httpclient|okhttp|go-http-client|axios\/|node-fetch|postman/i;
const TABLET = /ipad|tablet|kindle|silk\/|playbook|android(?!.*mobile)/i;
const MOBILE = /mobi|iphone|ipod|android|windows phone|blackberry|opera mini/i;
const DESKTOP = /windows nt|macintosh|mac os x|x11|linux|cros/i;

export const DEVICES = ['desktop', 'mobile', 'tablet', 'bot', 'other'];

export const deviceClass = (userAgent) => {
  if (typeof userAgent !== 'string' || userAgent.trim() === '') return 'other';
  if (BOT.test(userAgent)) return 'bot';
  if (TABLET.test(userAgent)) return 'tablet';
  if (MOBILE.test(userAgent)) return 'mobile';
  if (DESKTOP.test(userAgent)) return 'desktop';
  return 'other';
};
