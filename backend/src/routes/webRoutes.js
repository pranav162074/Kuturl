import { readFileSync } from 'node:fs';
import express from 'express';

const router = express.Router();

const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

const files = {
  page: read('index.html'),
  script: read('app.js'),
  style: read('style.css'),
};

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(files.page);
});

router.get('/static/app.js', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/javascript').send(files.script);
});

router.get('/static/style.css', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('css').send(files.style);
});

export default router;
