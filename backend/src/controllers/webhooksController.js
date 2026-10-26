import { randomBytes, randomUUID } from 'node:crypto';
import settings from '../config/webhooks.js';
import redis from '../config/redis.js';
import {
  createEndpoint,
  listEndpoints,
  findEndpoint,
  deleteEndpoint,
  enqueueEvent,
  listDeliveries,
  TooManyEndpointsError,
} from '../db/webhooks.js';
import { withTimeout } from '../utils/timeout.js';

const ID = /^[1-9]\d{0,17}$/;

const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Webhook endpoint not found' });

const publicEndpoint = ({ id, url, events, createdAt }) => ({ id, url, events, createdAt });

const ownedEndpoint = async (req, res) => {
  const endpoint = ID.test(req.params.id) ? await findEndpoint(req.params.id, req.apiKey.id) : null;
  if (!endpoint) notFound(res);
  return endpoint;
};

export const createEndpointHandler = async (req, res) => {
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  try {
    const endpoint = await createEndpoint({
      apiKeyId: req.apiKey.id,
      url: req.body.url,
      events: req.body.events,
      secret,
      max: settings.maxEndpointsPerKey,
    });
    res
      .set('Cache-Control', 'no-store')
      .status(201)
      .json({ ...publicEndpoint(endpoint), secret, notice: 'Store this secret now. It is used to verify signatures and cannot be shown again.' });
  } catch (error) {
    if (!(error instanceof TooManyEndpointsError)) throw error;
    res.status(409).json({
      error: 'too_many_endpoints',
      message: `You can register at most ${settings.maxEndpointsPerKey} webhook endpoints`,
    });
  }
};

export const listEndpointsHandler = async (req, res) => {
  res.json({ endpoints: (await listEndpoints(req.apiKey.id)).map(publicEndpoint) });
};

export const deleteEndpointHandler = async (req, res) => {
  if (!ID.test(req.params.id) || !(await deleteEndpoint(req.params.id, req.apiKey.id))) return notFound(res);
  res.status(204).end();
};

export const testEndpointHandler = async (req, res) => {
  const endpoint = await ownedEndpoint(req, res);
  if (!endpoint) return;

  const event = {
    id: randomUUID(),
    type: 'webhook.test',
    createdAt: new Date().toISOString(),
    data: { endpointId: endpoint.id, message: 'This is a test event from Kuturl' },
  };
  const queued = await enqueueEvent({ apiKeyId: req.apiKey.id, event, endpointId: endpoint.id });
  await withTimeout(redis.publish(settings.nudgeChannel, '1'), 250).catch(() => {});
  res.status(202).json({ eventId: event.id, queued: queued > 0 });
};

export const listDeliveriesHandler = async (req, res) => {
  const endpoint = await ownedEndpoint(req, res);
  if (!endpoint) return;

  const deliveries = await listDeliveries(endpoint.id);
  res.json({
    deliveries: deliveries.map(({ id, eventId, eventType, status, attempts, lastStatus, lastError, nextAttemptAt, createdAt, deliveredAt }) => ({
      id,
      eventId,
      eventType,
      status,
      attempts,
      lastStatus,
      lastError,
      nextAttemptAt: status === 'pending' ? nextAttemptAt : null,
      createdAt,
      deliveredAt,
    })),
  });
};
