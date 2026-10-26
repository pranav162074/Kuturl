import { getLink, toShortUrl } from '../services/links.js';
import { renderQr, qrEtag } from '../services/qrCodes.js';
import { isValidCodeShape } from '../utils/codeFormat.js';
import { qrCodes } from '../config/metrics.js';

const CONTENT_TYPES = { svg: 'image/svg+xml', png: 'image/png' };

export const qrHandler = async (req, res) => {
  const { code } = req.params;
  const link = isValidCodeShape(code) ? await getLink(code, req.apiKey.id) : null;
  if (!link) return res.status(404).json({ error: 'not_found', message: 'Link not found' });

  const { format, size, margin, ecc } = res.locals.query;
  const spec = { text: toShortUrl(link.code), format, size, margin, ecc };

  res.set({ ETag: qrEtag(spec), 'Cache-Control': 'private, max-age=86400', Vary: 'Authorization' });
  if (req.fresh) {
    qrCodes.inc({ format, result: 'not_modified' });
    return res.status(304).end();
  }

  const { body, fromMemory } = await renderQr(spec);
  qrCodes.inc({ format, result: fromMemory ? 'memory' : 'rendered' });

  res
    .type(CONTENT_TYPES[format])
    .set('Content-Disposition', `inline; filename="kuturl-${link.code}.${format}"`)
    .send(body);
};
