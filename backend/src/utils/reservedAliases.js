// Words that cannot be used as aliases. /:code is the last route, so any path that already
// has a route would shadow the alias, and some of these are routes added in later branches.
const RESERVED = new Set([
  // routes that exist or will exist
  'api', 'health', 'ping', 'metrics', 'docs', 'doc', 'swagger', 'openapi', 'redoc',
  'keys', 'links', 'stats', 'qr', 'bulk', 'unlock', 'v1', 'static', 'assets', 'public',
  // files that browsers and crawlers ask for
  'favicon', 'robots', 'sitemap',
  // words that would look official on a link that is not
  'admin', 'administrator', 'root', 'www', 'app', 'login', 'logout', 'signin', 'signup',
  'register', 'account', 'dashboard', 'settings', 'help', 'support', 'about', 'contact',
  'terms', 'privacy', 'status', 'null', 'undefined', 'kuturl',
]);

export const isReservedAlias = (alias) => RESERVED.has(alias.toLowerCase());