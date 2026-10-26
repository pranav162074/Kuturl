import logger from '../config/logger.js';
import settings from '../config/webhooks.js';
import { webhookDeliveries } from '../config/metrics.js';
import { claimDueDeliveries, finishDelivery, nextDueAt } from '../db/webhooks.js';
import { deliver } from '../services/webhookSender.js';

export const retryDelayFor = (attempt, random = Math.random) => {
  const base = settings.retryDelaysMs[Math.min(attempt, settings.retryDelaysMs.length) - 1];
  return Math.round(base * (0.8 + 0.4 * random()));
};

export const maxAttempts = () => settings.retryDelaysMs.length + 1;

const truncate = (text) => (text && text.length > 500 ? `${text.slice(0, 500)}...` : text);

export const createWebhookDispatcher = ({ subscriber = null } = {}) => {
  let running = false;
  let loop = null;
  let wake = null;
  let timer = null;

  const handle = async (delivery) => {
    const body = JSON.stringify(delivery.payload);
    const result = await deliver({
      url: delivery.url,
      secret: delivery.secret,
      body,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
    });

    if (result.ok) {
      await finishDelivery(delivery.id, { status: 'delivered', lastStatus: result.status });
      webhookDeliveries.inc({ result: 'delivered' });
      return 'delivered';
    }

    const lastError = truncate(result.error);
    if (delivery.attempts >= maxAttempts()) {
      await finishDelivery(delivery.id, { status: 'failed', lastStatus: result.status, lastError });
      webhookDeliveries.inc({ result: 'failed' });
      return 'failed';
    }

    const nextAttemptAt = new Date(Date.now() + retryDelayFor(delivery.attempts));
    await finishDelivery(delivery.id, { status: 'pending', lastStatus: result.status, lastError, nextAttemptAt });
    webhookDeliveries.inc({ result: 'retry' });
    return 'retry';
  };

  const runOnce = async () => {
    const claimed = await claimDueDeliveries({ limit: settings.batchSize, leaseMs: settings.leaseMs });
    const outcomes = await Promise.all(claimed.map(handle));
    return {
      claimed: claimed.length,
      delivered: outcomes.filter((o) => o === 'delivered').length,
      retried: outcomes.filter((o) => o === 'retry').length,
      failed: outcomes.filter((o) => o === 'failed').length,
    };
  };

  const sleep = (ms) =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    }).finally(() => {
      clearTimeout(timer);
      wake = null;
    });

  const nudge = () => wake?.();

  const run = async () => {
    while (running) {
      let delay = settings.idleCheckMs;
      try {
        let result;
        do {
          result = await runOnce();
        } while (running && result.claimed === settings.batchSize);

        const due = await nextDueAt();
        if (due) delay = Math.max(0, Math.min(settings.idleCheckMs, new Date(due).getTime() - Date.now()));
      } catch (error) {
        logger.error({ err: error }, 'Webhook dispatch failed');
        delay = 5000;
      }
      if (running) await sleep(delay);
    }
  };

  const start = async () => {
    if (running) return;
    running = true;
    if (subscriber) {
      subscriber.on('message', (channel) => {
        if (channel === settings.nudgeChannel) nudge();
      });
      await subscriber.subscribe(settings.nudgeChannel);
    }
    loop = run();
    logger.info('Webhook dispatcher started');
  };

  const stop = async () => {
    if (!running) return;
    running = false;
    nudge();
    await loop;
    if (subscriber) await subscriber.quit().catch(() => subscriber.disconnect());
    logger.info('Webhook dispatcher stopped');
  };

  return { start, stop, runOnce, nudge };
};
