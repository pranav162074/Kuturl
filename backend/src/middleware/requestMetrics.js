import { httpRequestDuration } from '../config/metrics.js';
import { routeLabel } from '../utils/routeLabel.js';

const requestMetrics = (req, res, next) => {
  const stop = httpRequestDuration.startTimer();
  res.on('finish', () => {
    stop({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
  });
  next();
};

export default requestMetrics;
