const express = require('express');
const router = express.Router();

router.use('/api/recetas', require('./recipes'));
router.use('/api/flujo', require('./flujo'));
router.use('/api/inventory', require('./inventory'));
router.use('/api/auditoria', require('./audit'));
router.use('/api', require('./auth'));

module.exports = router;