const t = require('fs').readFileSync('public/almacen.html', 'utf8').split(/\r?\n/);
for (let i = 1680; i < t.length; i++) {
    const s = t[i].replace(/\s+/g, ' ').trim();
    if (/^\}\);/.test(s)) console.log((i + 1) + ': FOREND ' + s.slice(0, 4));
    else if(/function mostrarInventarioAlmacen\(data\)|function renderIngresos\(lista\)|function cargarProductoTerminado\(\)|function cargarInventarioAlmacen\(\)/.test(s)) console.log((i + 1) + ': FUN ' + s.slice(0, 40));
}
