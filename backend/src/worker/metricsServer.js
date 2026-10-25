import http from 'node:http';
import { metricsResponse } from '../config/metrics.js';

export const createMetricsServer = () =>
  http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: 'Route not found' }));
      return;
    }

    try {
      const { status, headers, body } = await metricsResponse(req.headers.authorization);
      res.writeHead(status, headers);
      res.end(body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message: 'Something went wrong' }));
    }
  });
