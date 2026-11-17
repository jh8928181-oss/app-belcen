/**
 * /api/salud: la ruta de "sigue vivo" que usan los pings externos.
 *
 * Reglas que se cuidan aqui:
 *  1. Responde sin sesion: los pings de cron-job.org no traen token.
 *  2. No toca la base de datos (es un ping cada 10 minutos todo el dia).
 *  3. El resto de /api sigue protegido: el bypass es solo para /salud.
 *
 * Se prueba con HTTP de verdad contra la app (sin mocks de auth) para
 * ejercitar la cadena real de middlewares.
 */
const http = require('http');
const { app } = require('../index');

let srv;

beforeAll((done) => {
  srv = app.listen(0, done);
});

afterAll((done) => {
  srv.close(done);
});

function get(ruta) {
  return new Promise((resolve, reject) => {
    const peticion = http.request(
      { host: '127.0.0.1', port: srv.address().port, path: ruta, method: 'GET' },
      (res) => {
        let cuerpo = '';
        res.on('data', (c) => { cuerpo += c; });
        res.on('end', () => resolve({ status: res.statusCode, cuerpo }));
      }
    );
    peticion.on('error', reject);
    peticion.end();
  });
}

test('responde 200 y ok sin sesion', async () => {
  const r = await get('/api/salud');
  expect(r.status).toBe(200);
  const datos = JSON.parse(r.cuerpo);
  expect(datos.ok).toBe(true);
  expect(datos.servicio).toBe('app-belcen');
  expect(String(datos.hora || '').length).toBeGreaterThan(0);
});

test('no devuelve datos de negocio', async () => {
  const r = await get('/api/salud');
  const datos = JSON.parse(r.cuerpo);
  expect(Object.keys(datos).sort()).toEqual(['hora', 'ok', 'servicio', 'success']);
});

test('el resto de /api sigue exigiendo sesion', async () => {
  const r = await get('/api/inventario');
  expect(r.status).toBe(401);
});
