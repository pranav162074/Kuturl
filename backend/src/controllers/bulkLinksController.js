import { createLinks } from '../services/bulkLinks.js';
import { createLinkSchema } from '../utils/validators.js';
import { toLinkResponse } from './linksController.js';
import { bulkLinkItems } from '../config/metrics.js';

const invalid = (index, error) => ({
  index,
  status: 400,
  error: 'validation_error',
  message: error.issues[0].message,
  details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
});

export const bulkCreateHandler = async (req, res) => {
  const items = [];
  const results = new Array(req.body.links.length);

  req.body.links.forEach((raw, index) => {
    const parsed = createLinkSchema.safeParse(raw ?? {});
    if (parsed.success) items.push({ index, ...parsed.data });
    else results[index] = invalid(index, parsed.error);
  });

  if (items.length > 0) {
    for (const result of await createLinks(req.apiKey.id, items)) {
      results[result.index] =
        result.status === 201 ? { index: result.index, status: 201, ...toLinkResponse(result.link) } : result;
    }
  }

  const created = results.filter((result) => result.status === 201).length;
  const failed = results.length - created;
  bulkLinkItems.inc({ outcome: 'created' }, created);
  bulkLinkItems.inc({ outcome: 'failed' }, failed);

  res.status(failed === 0 ? 201 : 207).json({ created, failed, results });
};
