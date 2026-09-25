const fs = require('fs');
const t = fs.readFileSync('public/envasado.html', 'utf8').split(/\r?\n/);
let def = 0, call = 0, cardCase = 0;
for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (/function etiquetarTablas\(\)/.test(s)) { def++; console.log('DEF ' + (i + 1)); }
    else if (/^\s*etiquetarTablas\(\);/.test(s)) { call++; console.log('CALL ' + (i + 1)); }
    if (/class="tabla-wrap"/.test(s) && !/tabla-card-movil/.test(s)) { cardCase++; console.log('WRAP-SIN-CARD ' + (i + 1)); }
    if (/class="tabla-wrap\s+tabla-card-movil"/.test(s)) { cardCase++; console.log('WRAP-CARD ' + (i + 1)); }
}
console.log('RESUMEN def=' + def + ' calls=' + call + ' wrapsChequeados=' + cardCase);
