/**
 * Module Extractor v2 - finds game code
 * Paste in browser console on greenpump.xyz/flappy
 */
(() => {
    console.log('=== Module Extractor v2 ===\n');

    const tp = globalThis.TURBOPACK;
    if (!tp) { console.log('No TURBOPACK'); return; }

    // Explore structure
    console.log('TURBOPACK type:', typeof tp);
    console.log('TURBOPACK keys:', Object.keys(tp).slice(0, 20));
    console.log('TURBOPACK constructor:', tp.constructor?.name);

    // It might be an object where keys are chunk IDs
    // and values contain module definitions
    let allModules = [];

    function extractFromObj(obj, path, depth) {
        if (!obj || depth > 5) return;
        if (typeof obj === 'function') {
            const src = obj.toString();
            if (src.length > 50) {
                allModules.push({ path, src, size: src.length });
            }
            return;
        }
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                extractFromObj(obj[i], `${path}[${i}]`, depth + 1);
            }
        } else if (typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                extractFromObj(v, `${path}.${k}`, depth + 1);
            }
        }
    }

    extractFromObj(tp, 'TURBOPACK', 0);
    console.log(`\nExtracted ${allModules.length} functions from TURBOPACK`);

    // Search for game patterns
    const patterns = [
        ['gravity', /gravity/i],
        ['velocity/vy', /\.vy\b|velocity/i],
        ['bird', /\bbird\b/i],
        ['pipe', /\bpipe\b/i],
        ['gap', /\bgap\b/i],
        ['flap/jump', /\bflap\b|\bjump\b/i],
        ['canvas.getContext', /getContext/],
        ['requestAnimationFrame', /requestAnimationFrame/],
        ['drawImage', /drawImage/],
        ['fillRect', /fillRect/],
        ['0.28 gravity', /0\.28/],
        ['6.1 jump', /6\.1/],
        ['111 gap', /\b111\b/],
        ['940 canvas', /940/],
        ['580 canvas', /580/],
        ['cashout', /cashout/i],
        ['score', /\bscore\b/i],
    ];

    console.log('\n=== Searching all extracted functions ===\n');

    let hits = [];
    for (const mod of allModules) {
        let matched = [];
        for (const [name, regex] of patterns) {
            if (regex.test(mod.src)) matched.push(name);
        }
        if (matched.length >= 2) {
            hits.push({ ...mod, matched });
        }
    }

    hits.sort((a, b) => b.matched.length - a.matched.length);

    if (hits.length > 0) {
        console.log(`Found ${hits.length} functions with 2+ game patterns:\n`);
        for (const h of hits.slice(0, 15)) {
            console.log(`[${h.path}] ${h.size}B - matches: ${h.matched.join(', ')}`);
        }

        // Dump best match
        const best = hits[0];
        console.log(`\n=== BEST: ${best.path} (${best.size}B) ===\n`);
        console.log(best.src.slice(0, 8000));
        if (best.src.length > 8000) console.log('\n... truncated ...');
    } else {
        console.log('No game modules found in extracted functions.');
    }

    // 2nd approach: scan ALL script elements for inline game code
    console.log('\n=== Scanning script elements ===\n');
    const scripts = document.querySelectorAll('script');
    console.log(`Found ${scripts.length} script elements`);

    for (const s of scripts) {
        if (s.src && s.src.includes('_next')) {
            console.log(`  ${s.src.split('/').pop()}`);
        } else if (s.textContent && s.textContent.length > 200) {
            const txt = s.textContent;
            const hasGame = /bird|pipe|gravity|canvas|requestAnimationFrame/i.test(txt);
            console.log(`  [inline] ${txt.length}B ${hasGame ? '*** GAME CODE ***' : ''}`);
            if (hasGame) {
                console.log(txt.slice(0, 3000));
            }
        }
    }

    console.log('\n=== Done ===');
})();
