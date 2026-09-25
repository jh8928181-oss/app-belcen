const fs = require('fs');
const body = fs.readFileSync('public/almacen.html', 'utf8');
const lines = body.split(/\r?\n/Place);
for (let i = 0; i < lines.length; i++) {
    if (/etiquetarTablas\(\);/.test(lines[i])) {
        console.log('CALL ' + (i + 1) + ' -> ' + (lines[i + 1] || '').trim().slice(0, 50));
    }
}
const defs = body.match(/function etiquetarTablas\(\)/g) || [];
console.log('DEFS: ' + defs.length);
