const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authMiddleware, requerirRolAdmin, validarUsuarioBody } = require('../middleware/auth');

// Login público (sin authMiddleware)
router.post('/login', authController.login);

// Rutas protegidas (requieren token válido)
router.use(authMiddleware);

// Gestión de usuarios (solo admin)
router.get('/usuarios', requerirRolAdmin, authController.listarUsuarios);
router.post('/usuarios', requerirRolAdmin, validarUsuarioBody, authController.crearUsuario);
router.post('/usuarios/:id/editar', requerirRolAdmin, authController.editarUsuario);
router.post('/usuarios/:id/eliminar', requerirRolAdmin, authController.eliminarUsuario);

module.exports = router;