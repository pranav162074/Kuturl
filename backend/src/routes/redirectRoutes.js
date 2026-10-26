import express from 'express';
import { redirectToLink, unlockLink } from '../controllers/redirectController.js';

const router = express.Router();

router.get('/:code', redirectToLink);
router.post('/:code/unlock', express.urlencoded({ extended: false, limit: '2kb' }), unlockLink);

export default router;