require('dotenv').config();
const pool = require('./db');
const { normalizar, estadoDe } = require('./utils/helpers');

const articulos = [
    ['Botella de 200 ml - B-1', 23326, 'UNIDADES'],
    ['Botella de 500 ml - B-1', 10906, 'UNIDADES'],
    ['Botella de 900 ml - B-1', 0, 'UNIDADES'],
    ['Botella de 1 Lt - B-1', 56619, 'UNIDADES'],
    ['Botella de 2 Lt - B-1', 0, 'UNIDADES'],
    ['Galonera B-1 x 5 lt', 1038, 'UNIDADES'],
    ['Botella de 800ml - Don Lalo', 3604, 'UNIDADES'],
    ['Botella Belini x 3 lt', 952, 'UNIDADES'],
    ['Botella Belini x 200 ml', 12250, 'UNIDADES'],
    ['Botella Belini x 500 ml', 18757, 'UNIDADES'],
    ['Botella Belini x 900 ml', 7087, 'UNIDADES'],
    ['Botella Belini x 1 Lt', 2092, 'UNIDADES'],
    ['Galonera Belini x 2 lt', 0, 'UNIDADES'],
    ['Galonera Belini x 5 lt', 0, 'UNIDADES'],
    ['Lata Belini 18lt', 1400, 'UNIDADES'],
    ['Balde Belini x 18 lt', 5, 'UNIDADES'],
    ['Balde Don Lalo x 20lt', 185, 'UNIDADES'],
    ['Botella VEGA x 900 ml', 0, 'UNIDADES'],

    ['Caja B-1 x 200 ml', 2194, 'UNIDADES'],
    ['Caja B-1 x 500 ml', 14262, 'UNIDADES'],
    ['Caja B-1 x 900 ml', 72915, 'UNIDADES'],
    ['Caja B-1 x 1 lt', 0, 'UNIDADES'],
    ['Caja B-1 x 2 lt', 1965, 'UNIDADES'],
    ['Caja B-1 x 5 lt', 2338, 'UNIDADES'],
    ['Caja Don Lalo x 800ml x 12 und', 25615, 'UNIDADES'],
    ['Caja Belini x 200 ml', 7772, 'UNIDADES'],
    ['Caja Belini x 500 ml', 33119, 'UNIDADES'],
    ['Caja Belini x 900 ml', 14435, 'UNIDADES'],
    ['CAJA BELINI X 1 LITRO', 21514, 'UNIDADES'],
    ['Caja Belini x 2 lt', 1429, 'UNIDADES'],
    ['Caja Belini x 5 lt', 5579, 'UNIDADES'],
    ['Caja BELINI X 3 LITROS', 4304, 'UNIDADES'],
    ['CAJA TIMONEL 900ML X 12 UND', 4251, 'UNIDADES'],
    ['CAJA ACEITE VEGA 900ML X 12 UND', 5314, 'UNIDADES'],

    ['Tapa dosif. N° 26 blanco / Dorado', 75.04, 'MILL'],
    ['Tapa dosif. N° 28 blanco / Dorado', 25.82, 'MILL'],
    ['Asas plasticas /Dorado (2LT)', 4.00, 'MILL'],
    ['Tapones Verdes', 0.00, 'MILL'],
    ['Tapa Dosf. N° 28 / Celeste', 0.00, 'MILL'],
    ['Tapa color Rojo 2lt', 3.01, 'MILL'],
    ['Tapa Tapon 26mm (200ml)', 32.57, 'MILL'],
    ['Tapa color Celeste 3lt', 7.60, 'MILL'],
    ['Asas plasticas color celeste pico 45', 7.60, 'MILL'],
    ['Tapa BALDE BELINI color amarillo', 1786.00, 'UNIDADES'],
    ['Tapa color rojo 5lt', 1.44, 'MILL'],
    ['TAAAAPA BALDE DON LALO', 745, 'UNIDADES'],
    ['Tapa Dosif. N° 26 blanco / ROJO', 65.87, 'MILL', 'TAPAS Y ACCESORIOS', true],
    ['Tapa Dosif. N° 26 blanco / VERDE', 53.21, 'MILL', 'TAPAS Y ACCESORIOS', true],

    ['SERVICIO SAUÑE (1LT-900ML)', 55.95, 'MILL'],
    ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 75.00, 'MILL'],
    ['Preforma cristal 23.5 gr (PICO 26MM)', 38.41, 'MILL'],
    ['Preforma cristal de 26.3 GR (PICO 28MM)', 0.00, 'MILL'],
    ['Preforma 45 GR (2 LT)', 0.00, 'MILL'],
    ['Preforma cristal 15 GR (26 MLL - 500ML)', 40.00, 'MILL'],
    ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 0.00, 'MILL'],
    ['Preforma cristal de 104 gr pico 45mm (3LT)', 5.00, 'MILL'],
    ['SERVICIO B&M DYLPLAST (PREFORMAS 23.5GR)', 88.85, 'MILL'],
    ['Preforma cristal 21 gr (PICO 26MM)', 98.00, 'MILL', 'PREFORMAS Y SERVICIOS', true],

    ['Etiqueta couche 90 gr x 200 ml B-1', 85.00, 'MILL'],
    ['Etiqueta couche 90 gr x 500 ml B-1', 176.70, 'MILL'],
    ['Etiqueta couche 90 gr x 900 ml B-1', 306.49, 'MILL'],
    ['Etiqueta couche 90 gr x 1 lt B-1', 135.28, 'MILL'],
    ['Etiqueta couche 90 gr x 2 lt B-1', 84.19, 'MILL'],
    ['Etiqueta polipropileno blanco x 5 lt B-1', 9.00, 'MILL'],
    ['Etiqueta couche 90gr x 800 ml Don Lalo', 76.34, 'MILL'],
    ['Etiqueta couche 90 gr x 500 ml Belini', 136.74, 'MILL'],
    ['Etiqueta couche 90 gr x 900 ml Belini', 50.00, 'MILL'],
    ['Etiqueta couche 90 gr x 1 lt Belini', 40.00, 'MILL'],
    ['Etiqueta polipropileno blanco x 3 lt Belini', 27.64, 'MILL'],
    ['Etiqueta couche 90 gr x 200 ml Belini', 40.00, 'MILL', 'ETIQUETAS', true],
    ['Etiqueta polipropileno blanco x 2 lt Belini', 23.98, 'MILL', 'ETIQUETAS', true],
    ['Etiqueta polipropileno blanco x 5 lt Belini', 22.00, 'MILL', 'ETIQUETAS', true],
    ['Etiqueta couche 90 gr x 900ml TIMONEL', 11.00, 'MILL', 'ETIQUETAS', true],
    ['Etiqueta couche 90 gr x 900 ml VEGA', 6.60, 'MILL', 'ETIQUETAS', true]
];

function selftest() {
    const nuevos = articulos.filter(a => a[4] === true).length;
    if (articulos.length !== 74) throw new Error('Total de filas esperado 74, hay ' + articulos.length);
    if (nuevos !== 8) throw new Error('Filas nuevas esperadas 8, hay ' + nuevos);
    const casos = [
        ['Tapa Dosf. N° 28 / Celeste', 'Tapa Dosf. N°28 / Celeste'],
        ['Etiqueta couche 90gr x 800 ml Don Lalo', 'Etiqueta couche 90 gr x 800 ml Don Lalo']
    ];
    casos.forEach(([a, b]) => {
        if (normalizar(a) !== normalizar(b)) throw new Error('Normalizacion fallo entre: ' + a + ' | ' + b);
    });
    const unicos = new Set(articulos.map(a => normalizar(a[0])));
    if (unicos.size !== articulos.length) throw new Error('Hay nombres normalizados duplicados en el dataset');
    console.log('SELFTEST OK | filas:', articulos.length, '| nuevas:', nuevos, '| normalizacion pasada');
    process.exit(0);
}

if (process.env.SELFTEST) selftest();

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const actuales = (await client.query('SELECT id, nombre, stock FROM inventario')).rows;
        const mapa = new Map(actuales.map(r => [normalizar(r.nombre), r]));

        let actualizados = 0;
        let insertados = 0;
        let sinCambios = 0;
        let noEncontrados = [];

        for (const [nombre, stock, unidad, categoria, esNuevo] of articulos) {
            const fila = mapa.get(normalizar(nombre));
            if (fila) {
                if (Number(fila.stock) === Number(stock)) {
                    sinCambios++;
                    continue;
                }
                await client.query(
                    `UPDATE inventario SET stock = $1, unidad_medida = $2, estado = $3 WHERE id = $4`,
                    [stock, unidad, estadoDe(stock), fila.id]
                );
                actualizados++;
                console.log(`[OK] ${fila.nombre} : ${fila.stock} -> ${stock}`);
            } else if (esNuevo) {
                await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, $2, $3, $4, $5)`,
                    [nombre, categoria, stock, unidad, estadoDe(stock)]
                );
                insertados++;
                console.log(`[NUEVO] ${nombre} (${categoria}) : ${stock} ${unidad}`);
            } else {
                noEncontrados.push(nombre);
                console.log(`[NO ENCONTRADO] ${nombre}`);
            }
        }

        await client.query('COMMIT');
        console.log('----------------------------------------');
        console.log('Resumen: ' + actualizados + ' actualizados | ' + insertados + ' insertados | ' + sinCambios + ' sin cambios | ' + noEncontrados.length + ' no encontrados');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error durante la actualizacion:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        process.exit();
    }
})();