const fs = require('fs');
const t = fs.readFileSync('public/almacen.html', 'utf8');
const aes = [...t.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let inline = '';
for (const a of aes) { if (a.length > inline.length) inline = a; }
fs.writeFileSync('Temp/opencode/chk-alm-big.js', inline);
console.log('Extraido ' + inline.length + ' chars en Temp/opencode/chk-alm-big.js');
