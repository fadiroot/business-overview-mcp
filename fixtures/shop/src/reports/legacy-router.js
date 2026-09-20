const express = require('express');
const { requireAuth, requireRole } = require('../auth/middleware');
const router = express.Router();
router.get('/summary', requireAuth, requireRole('ADMIN', 'AUDITOR'), (req, res) => res.json({}));
router.post('/export', (req, res) => res.json({}));
router.delete('/purge', requireAuth, (req, res) => res.json({}));
module.exports = router;
