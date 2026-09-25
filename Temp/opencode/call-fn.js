const fs = require('fs');
const L = fs.readFileSync('public/almacen.html', 'utf8').split(/\r?\n/);
let fn = null;
const out = [];
L.forEach((s, i) => {
    const n = i + 1;
    const m = s.match(/^\s*async\s+function\s+([A-Za-z0-9_]+)\s*\(/);
    if (m) fn = m[1];
    const c = s.match(/^\s*function\s+([A-Za-z0-9_]+)\s*\(/);
    if (c) fn = c[1];
    if (/^\s*etiquetarTablas\(\);/.test(s)) out.push('CALL ' + n + ' EN ' + fn);
});
console.log(out.join('\n'));
