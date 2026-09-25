const fs = require('fs');
const dec = new TextDecoder('windows-1252');
const map = {};
for (let b = 0; b < 256; b++) map[dec.decode(Uint8Array.of(b))] = b;
const buf = fs.readFileSync('public/almacen.html');
const m = buf.toString('utf8');
let hasBom = m.charCodeAt(0) === 0xFEFF;
let body = hasBom ? m.slice(1) : m;
const unknown = [];
const orig = [];
for (const c of body) {
  if (map[c] === undefined) unknown.push(c + ' U+' + c.charCodeAt(0).toString(16));
  else orig.push(map[c]);
}
const original = Buffer.from(orig).toString('utf8');
const ok = original.includes('Gestión de Inventario y Almacén') && !original.includes('GestiÃ');
console.log('bodyChars=' + [...body].length + ' unknown=' + unknown.length + ' hadBom=' + hasBom + ' ok=' + ok);
if (!ok) {
  console.log('unknownSample=' + unknown.slice(0, 10).join(' | '));
  console.log('head=' + JSON.stringify(original.slice(20, 80)));
  process.exit(1);
}
fs.writeFileSync('Temp/opencode/almacen-recovered.html', original);
console.log('RECOVERY-OK');