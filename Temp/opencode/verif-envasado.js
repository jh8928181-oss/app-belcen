const fs = require('fs');
const t = fs.readFileSync('public/envasado.html', 'utf8').split(/\r?\n/);
let def = 0, callN = 0, wrapCard = 0, wrapPlain = 0;
for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (/function etiquetarTablas\(\)/.test(s)) { def++; console.log('DEF ' + (i + 1)); }
    else if (/^\s*etiquetarTablas\(\);/.test(s)) { callN++; console.log('CALL ' + (i + 1)); }
    if (/<div class="tabla-wrap\s+tabla-card-movil"/.test(s)) { wrapCard++; console.log('WRAP-CARD ' + (i + 1)); }
    else if (/<div class="tabla-wrap"/.test(s)) { wrapPlain++; console.log('WRAP-PLAIN ' + (i + 1)); }
}
console.log('RESUMEN def=' + def + ' calls=' + callN + ' wrapCard=' + wrapCard + ' wrapPlain=' + wrapPlain);
