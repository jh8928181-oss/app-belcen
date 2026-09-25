const fs = require('fs');
const t = fs.readFileSync('public/envasado.html', 'utf8');
const L = t.split(/\r?\n/);
let hasWrap = 0, tableTotal = 0;
L.forEach((s, i) => {
    const n = i + 1;
    if (/<table\b/.test(s)) {
        tableTotal++;
        const env = n - 5 > 0 ? L.slice(Math.max(0, n - 6), n - 1) : [];
        const wrap = env.some(x => x.indexOf('tabla-wrap') > -1);
        console.log('TABLE ' + n + ' wrap=' + wrap + ' :: ' + s.replace(/^\s+/, '').slice(0, 40));
        if (wrap) hasWrap++;
    }
    if (/id="(tabla|resumen|contenedor|tbody)[A-Za-z]*"/.test(s) && /<table/.test(L.slice(0, n).join('\n'))) {
        // noop
    }
});
console.log('--- tables=' + tableTotal + ' conWrap=' + hasWrap);
