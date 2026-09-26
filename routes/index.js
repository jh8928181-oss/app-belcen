const express = require('express');
const router = express.Router();

// Rutas de autenticación
router.use('/api', require('./auth'));

// Aquí se agregarán más rutas modulares
// router.use('/api/inventario', require('./inventario'));
// router.use('/api/vigilancia', require('./vigilancia'));
// router.use('/api/almacen', require('./almacen'));
// router.use('/api/produccion', require('./produccion'));
// router.use('/api/refinado', require('./refinado'));
// router.use('/api/soplado', require('./soplado'));
// router.use('/api/proveedores', require('./proveedores'));
// router.use('/api/reportes', require('./reportes'));

module.exports = router;