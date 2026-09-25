const t = require('fs').readFileSync('public/almacen.html', 'utf8').split(/\r?\n/);
const targets = [1400, 1454, 1702, 1721, 1843];
for (const n of targets) {
    console.log('=== ' + (n + 1) + ' ===');
    for (let k = n - 53; k <= n - 50; k++) {
        if (t[k] === undefined || t[k + 50] === undefined) break;
    }
    // show 1 line above and 1 line of the target region
    for (let k = n - 1; k <= n + 1; k++) {
        if (t[k] !== undefined) console.log((k + 1) + ': ' + t[k].replace(/\s+/g, ' ').trim().slice(0, 70));
    }
}
