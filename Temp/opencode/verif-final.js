const fs = require('fs');
function mapa(file) {
    const t = fs.readFileSync(file, 'utf8');
    const L = t.split(/\r?\n/);
    const wraps = [];
    let def = 0, calls = 0;
    L.forEach((s, i) => {
        const n = i + 1;
        if (/class="tabla-wrap/.test(s) && /<div/.test(s)) {
            const card = /tabla-card-movil/.test(s);
            wraps.push((card ? 'CARD ' : 'PLAIN ') + n + ' :: ' + s.replace(/^\s+/, '').slice(0, 46));
        }
        if (/^\s*function\s+etiquetarTablas\s*\(/.test(s)) def++;
        if (/^\s*etiquetarTablas\(\);/.test(s)) calls++;
    });
    console.log('=== ' + file + ' ===');
    console.log(wraps.join('\n'));
    console.log('def=' + def + ' calls=' + calls);
}
mapa(process.argv[2] || 'public/almacen.html');
