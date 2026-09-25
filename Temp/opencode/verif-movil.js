const fs = require('fs');
const files = ['public/almacen.html', 'public/envasado.html', 'public/refinado.html'];
files.forEach(f => {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    let defs = 0, calls = 0, wraps = 0, media640 = false, cardcss = 0;
    lines.forEach((ln, i) => {
        if (/function etiquetarTablas\(\)/.test(ln)) defs++;
        if (/^\s*etiquetarTablas\(\);/.test(ln)) calls++;
        if (/class="tabla-wrap tabla-card-movil"/.test(ln)) wraps++;
        if (/@media \(max-width: 640px\)/.test(ln)) media640 = true;
        if (/\.tabla-card-movil td::before/.test(ln)) cardcss++;
    });
    console.log(f + ' => defs=' + defs + ' calls=' + calls + ' wraps=' + wraps + ' media640=' + media640 + ' cardcss=' + cardcss);
});
