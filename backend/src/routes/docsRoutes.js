import express from 'express';
import env from '../config/env.js';
import spec from '../docs/openapi.js';
import { renderDocs } from '../docs/renderDocs.js';

const router = express.Router();

const document = { ...spec, servers: [{ url: env.baseUrl }] };
const page = renderDocs(document, { baseUrl: env.baseUrl });

router.get('/', (req, res) => res.redirect(302, '/docs'));

router.get('/docs', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').type('html').send(page);
});

router.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').json(document);
});

export default router;
