import { routeLabel } from '../utils/routeLabel.js';

export const accessLogOptions = {
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.raw?.originalUrl ?? req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  customProps: (req, res) => {
    const cache = res.getHeader('x-cache');
    return {
      route: routeLabel(req),
      ...(req.apiKey && { apiKeyId: req.apiKey.id }),
      ...(cache && { cache }),
    };
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode === 429) return 'warn';
    return 'info';
  },
};
