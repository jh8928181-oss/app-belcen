const fs = require('fs');
const t = fs.readFileSync('public/almacen.html', 'utf8');
const m = t.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
if (!m) { console.error('NO SCRIPT BLOCK'); process.exit(1); }
fs.writeFileSync('Temp/opencode/almacen-inline.js', m[1].replace(/\r\n/g, '\n'));
console.log('WRITE-OK ' + m[1].length);