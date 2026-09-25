const fs = require('fs');
const t = fs.readFileSync('public/envasado.html', 'utf8');
const lines = t.split(/\r?\n/);
const out = [];
lines.forEach((s, i) => {
    const n = i + 1;
    if (s.indexOf('tabla-wrap') > -1 && s.indexOf('class=') > -1) {
        const card = s.indexOf('tabla-card-movil') > -1;
        out.push((card ? 'WRAP-CARD ' : 'WRAP-PLAIN ') + n + ' :: ' + s.replace(/^\s+/, '').slice(0, 56));
    }
    const m = s.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m && /^(mo|render|listar|refrescar|aplic|most)/i.test(m[1])) out.push('FUNC ' + n + ' :: ' + m[1]);
    if (/^\s*etiquetarTablas\(\);/.test(s)) out.push('CALL ' + n);
    if (/function\s+etiquetarTablas\s*\(/.test(s)) out.push('DEF ' + n);
});
console.log(out.join('\r\n'));
