const fs = require('fs');
const t = fs.readFileSync('public/envasado.html', 'utf8');
const lines = t.split(/\r?\n/);
const out = [];
lines.forEach((s, i) => {
    const n = i + 1;
    if (s.indexOf('tabla-wrap') > -1 && s.indexOf('<div') > -1 && s.indexOf('class=') > -1) {
        const card = s.indexOf('tabla-card-movil') > -1;
        out.push((card ? 'WRAP-CARD ' : 'WRAP-PLAIN ') + n + ' :: ' + s.replace(/^\s+/, '').slice(0, 52));
    }
    const f = s.match(/\bfunction\s+(render|renderizar|car|most|list|refrescar|mostrar|construir|aplicar|etiquetar)[A-Za-z]*\s*\(/);
    if (f) out.push('FUNC ' + n + ' :: ' + f[0].replace(/\s+\(\s*$/, '()'));
    if (/^\s*etiquetarTablas\(\);/.test(s)) out.push('CALL ' + n);
    if (/function\s+etiquetarTablas\s*\(/.test(s)) out.push('DEF ' + n);
});
out.forEach(x => console.log(x));
console.log('--- wraps=' + (lines.join('\n').match(/<div class="tabla-wrap/g) || []).length);
