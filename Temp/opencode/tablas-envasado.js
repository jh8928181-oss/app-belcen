const fs = require('fs');
const t = fs.readFileSync('public/envasado.html', 'utf8');
const L = t.split(/\r?\n/);
const tablas = [];
L.forEach((s, i) => {
    const n = i + 1;
    const m = s.match(/^\s*<table\b/);
    if (!m) return;
    const ctx = L.slice(Math.max(0, n - 6), n - 1);
    const wrap = ctx.filter(x => /class="tabla-wrap/.test(x));
    const wrapLine = wrap.length ? (n - ctx.length + ctx.indexOf(wrap[0]) + 1) : 0;
    let id = '';
    if (/id="([A-Za-z0-9_]+)"/.test(s)) id = ' id=' + s.match(/id="([A-Za-z0-9_]+)"/)[1];
    const etiquetado = wrapLine && /tabla-card-movil/.test(ctx[ctx.indexOf(wrap[0])]);
    tablas.push((etiquetado ? 'TABLE-CARD  ' : 'TABLE-PLAIN ') + n + id);
});
console.log(tablas.join('\n'));
