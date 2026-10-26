const PREFIXES = ['/api/v1/links', '/api/v1/keys', '/api/v1/webhooks', '/api/v1'];

export const routeLabel = (req) => {
  if (req.route?.path) {
    const base = req.baseUrl ?? '';
    const path = req.route.path === '/' && base ? '' : req.route.path;
    return `${base}${path}`;
  }

  const url = (req.originalUrl ?? req.url ?? '').split('?')[0];
  const prefix = PREFIXES.find((candidate) => url === candidate || url.startsWith(`${candidate}/`));
  return prefix ? `${prefix}/*` : 'unmatched';
};
