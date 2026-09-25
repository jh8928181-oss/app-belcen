const fs = require('fs');
function analiza(file) {
    const t = fs.readFileSync(file, 'utf8');
    const L = t.split(/\r?\n/);
    const R = { file, wraps: [], def: 0, calls: [], defs: [] };
    L.forEach((s, i) => {
        const n = i + 1;
        if (s.indexOf('tabla-wrap') > -1 && s.indexOf('<div') > -1 && s.indexOf('class=') > -1) {
            const card = s.indexOf('tabla-card-movil') > -1;
            R.wraps.push((card ? 'CARD ' : 'PLAIN ') + n);
        }
        if (/^\s*function\s+etiquetarTablas\s*\(/.test(s)) R.defs.push(n);
        if (/^\s*etiquetarTablas\(\);/.test(s)) R.calls.push(n);
    });
    R.wrapsCard = R.wraps.filter(w => /^CARD/.test(w)).length;
    R.wrapsPlain = R.wraps.length - R.wrapsCard;
    console.log('=== ' + file + ' ===');
    console.log('  DEFS: ' + R.defs.join(',') + '  CALLS(' + R.calls.length + '): ' + R.calls.join(','));
    console.log('  WRAPS: ' + R.wraps.join('  '));
    console.log('  RESUMEN: defs=' + R.defs.length + ' calls=' + R.calls.length + ' wrapCard=' + R.wrapsCard + ' wrapPlain=' + R.wrapsPlain);
    return R;
}
for (const f of ['public/almacen.html', 'public/envasado.html']) analiza(f);
