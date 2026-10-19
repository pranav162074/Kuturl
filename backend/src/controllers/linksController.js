import { createLink, toShortUrl } from '../services/links.js';

export const toLinkResponse = (link) => ({
  code: link.code,
  shortUrl: toShortUrl(link.code),
  longUrl: link.longUrl,
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
});

// @route POST /api/v1/links
export const createLinkHandler = async (req, res) => {
  const link = await createLink({
    apiKeyId: req.apiKey.id,
    longUrl: req.body.url,
    expiresAt: req.body.expiresAt,
  });

  res.status(201).json(toLinkResponse(link));
};