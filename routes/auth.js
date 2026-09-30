const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authMiddleware, requerirRolAdmin, validarUsuarioBody } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/logout', authMiddleware, authController.logout);

router.use(authMiddleware);

router.get('/usuarios', requerirRolAdmin, authController.listarUsuarios);
router.post('/usuarios', requerirRolAdmin, validarUsuarioBody, authController.crearUsuario);
router.post('/usuarios/:id/editar', requerirRolAdmin, authController.editarUsuario);
router.post('/usuarios/:id/eliminar', requerirRolAdmin, authController.eliminarUsuario);

module.exports = router;