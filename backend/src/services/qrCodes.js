import { createHash } from 'node:crypto';
import QRCode from 'qrcode';

const RENDERER_VERSION = 1;
const MAX_CACHED = 200;

const rendered = new Map();

export const qrEtag = ({ text, format, size, margin, ecc }) => {
  const digest = createHash('sha256')
    .update(JSON.stringify([RENDERER_VERSION, text, format, size, margin, ecc]))
    .digest('hex')
    .slice(0, 32);
  return `"qr-${digest}"`;
};

const render = async ({ text, format, size, margin, ecc }) => {
  const options = { errorCorrectionLevel: ecc, margin, width: size };
  if (format === 'png') return QRCode.toBuffer(text, { ...options, type: 'png' });
  return Buffer.from(await QRCode.toString(text, { ...options, type: 'svg' }), 'utf8');
};

export const renderQr = async (spec) => {
  const key = qrEtag(spec);
  const hit = rendered.get(key);
  if (hit) {
    rendered.delete(key);
    rendered.set(key, hit);
    return { body: hit, fromMemory: true };
  }

  const body = await render(spec);
  rendered.set(key, body);
  if (rendered.size > MAX_CACHED) rendered.delete(rendered.keys().next().value);
  return { body, fromMemory: false };
};

export const clearRenderedQrCodes = () => rendered.clear();
