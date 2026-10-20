import express from 'express';
import { redirectToLink } from '../controllers/redirectController.js';

const router = express.Router();

router.get('/:code', redirectToLink);

export default router;