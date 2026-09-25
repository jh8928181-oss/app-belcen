const { readFileSync } = require('fs');
const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
let def = 0, call = 0, wrapCard = 0, wrapPlain = 0;
const wrappers = [];
for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (s.indexOf('function etiquetarTablas()') > -1) { def++; wrappers.push('DEF ' + (i + 1)); }
    else if (/^\s*etiquetarTablas\(\);/.test(s)) { call++; wrappers.push('CALL ' + (i + 1)); }
    if (s.indexOf('tabla-wrap') > -1 && s.indexOf('<div') > -1 && s.indexOf('class=') > -1) {
        const card = s.indexOf('tabla-card-movil') > -1;
        if (card) { wrapCard++; wrappers.push('WRAP-CARD ' + (i + 1)); }
        else { wrapPlain++; wrappers.push('WRAP-PLAIN ' + (i + 1)); }
    }
}
console.log('=== ' + file + ' ===');
wrappers.forEach(w => console.log('  ' + w));
console.log('def=' + def + ' calls=' + call + ' wrapCard=' + wrapCard + ' wrapPlain=' + wrapPlain);
