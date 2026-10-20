import { createLink, getLink, listLinks, changeLink, removeLink, toShortUrl } from '../services/links.js';
import { isValidCodeShape } from '../utils/codeFormat.js';
import codes from '../services/codes.js';

// What the create endpoint returns
export const toLinkResponse = (link) => ({
  code: link.code,
  shortUrl: toShortUrl(link.code),
  longUrl: link.longUrl,
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
});

const statusOf = (link, now) => {
  if (link.disabledAt) return 'disabled';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now) return 'expired';
  return 'active';
};

// What the view, list and update endpoints return
export const toLinkDetails = (link, now = Date.now()) => ({
  ...toLinkResponse(link),
  status: statusOf(link, now),
  disabledAt: link.disabledAt,
  isCustom: link.isCustom,
});

// Someone else's link and a link that doesn't exist look exactly the same
const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Link not found' });

// @route POST /api/v1/links
export const createLinkHandler = async (req, res) => {
  const link = await createLink({
    apiKeyId: req.apiKey.id,
    longUrl: req.body.url,
    expiresAt: req.body.expiresAt,
  });

  res.status(201).json(toLinkResponse(link));
};

// @route GET /api/v1/links?limit=&cursor=
export const listLinksHandler = async (req, res) => {
  const { limit, cursor } = res.locals.query;
  const { links, hasMore } = await listLinks(req.apiKey.id, { limit, cursor });

  const now = Date.now();
  res.json({
    links: links.map((link) => toLinkDetails(link, now)),
    nextCursor: hasMore ? codes.encode(links[links.length - 1].id) : null,
  });
};

// @route GET /api/v1/links/:code
export const getLinkHandler = async (req, res) => {
  const { code } = req.params;
  if (!isValidCodeShape(code)) return notFound(res);

  const link = await getLink(code, req.apiKey.id);
  if (!link) return notFound(res);

  res.json(toLinkDetails(link));
};

// @route PATCH /api/v1/links/:code
export const updateLinkHandler = async (req, res) => {
  const { code } = req.params;
  if (!isValidCodeShape(code)) return notFound(res);

  const link = await changeLink(code, req.apiKey.id, req.body);
  if (!link) return notFound(res);

  res.json(toLinkDetails(link));
};

// @route DELETE /api/v1/links/:code
export const deleteLinkHandler = async (req, res) => {
  const { code } = req.params;
  if (!isValidCodeShape(code)) return notFound(res);

  if (!(await removeLink(code, req.apiKey.id))) return notFound(res);
  res.status(204).end();
};