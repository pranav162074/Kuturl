import { randomUUID } from 'node:crypto';
import {
  claimIdempotencyKey,
  findIdempotencyKey,
  saveIdempotentResponse,
  releaseIdempotencyKey,
} from '../db/idempotencyKeys.js';
import { requestHash } from '../utils/requestHash.js';
import { idempotencyRequests } from '../config/metrics.js';

const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
const MAX_CLAIM_ATTEMPTS = 3;

const inProgress = (res) => {
  idempotencyRequests.inc({ outcome: 'in_progress' });
  return res.status(409).set('Retry-After', '1').json({
    error: 'idempotency_request_in_progress',
    message: 'A request with this Idempotency-Key is still being processed, retry shortly',
  });
};

const recordOutcome = (req, res, next, owner) => {
  let settled = false;
  const send = res.json.bind(res);

  res.json = (body) => {
    if (settled) return send(body);
    settled = true;

    const outcome =
      res.statusCode >= 500
        ? releaseIdempotencyKey(owner)
        : saveIdempotentResponse({ ...owner, status: res.statusCode, body });

    outcome
      .catch((error) => req.log.error({ err: error }, 'Could not record the idempotent response'))
      .finally(() => send(body));
    return res;
  };

  res.on('close', () => {
    if (settled) return;
    settled = true;
    releaseIdempotencyKey(owner).catch((error) =>
      req.log.error({ err: error }, 'Could not release the idempotency key')
    );
  });

  next();
};

const idempotency = async (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return next();

  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Idempotency-Key must be 1 to 255 visible ASCII characters',
    });
  }

  const apiKeyId = req.apiKey.id;
  const hash = requestHash(req);

  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    if (await claimIdempotencyKey({ apiKeyId, key, requestHash: hash, token })) {
      idempotencyRequests.inc({ outcome: 'new' });
      return recordOutcome(req, res, next, { apiKeyId, key, token });
    }

    const record = await findIdempotencyKey(apiKeyId, key);
    if (!record) continue;

    if (record.requestHash !== hash) {
      idempotencyRequests.inc({ outcome: 'key_reused' });
      return res.status(422).json({
        error: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used with a different request',
      });
    }

    if (record.status === 'processing') return inProgress(res);

    idempotencyRequests.inc({ outcome: 'replayed' });
    return res.status(record.responseStatus).set('Idempotent-Replayed', 'true').json(record.responseBody);
  }

  return inProgress(res);
};

export default idempotency;
