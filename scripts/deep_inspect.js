/**
 * Deep Game Inspector - finds hidden game state
 * Paste in browser console on greenpump.xyz/flappy
 */
(async () => {
    console.log('=== Deep Game Inspector ===\n');

    const canvas = document.querySelector('canvas');
    if (!canvas) { console.log('No canvas found'); return; }

    // 1. Brute-force walk ALL fibers
    const fiberKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber$'));
    if (!fiberKey) { console.log('No fiber'); return; }

    let fiber = canvas[fiberKey];
    let allObjects = [];
    let visited = new Set();

    function walk(node, depth) {
        if (!node || depth > 40 || visited.has(node)) return;
        visited.add(node);

        // Check memoizedState chain
        let hook = node.memoizedState;
        let hi = 0;
        while (hook && hi < 30) {
            const s = hook.memoizedState;
            if (s && typeof s === 'object' && s !== null && !visited.has(s)) {
                visited.add(s);
                const keys = Object.keys(s);
                if (keys.length > 2) {
                    allObjects.push({ depth, hook: hi, keys, ref: s.current !== undefined ? s : null, obj: s });
                }
                // Check .current for refs
                if (s.current && typeof s.current === 'object' && s.current !== null && !visited.has(s.current)) {
                    visited.add(s.current);
                    const ck = Object.keys(s.current);
                    if (ck.length > 2) {
                        allObjects.push({ depth, hook: hi, keys: ck, ref: s.current, obj: s.current });
                    }
                }
            }
            hook = hook.next;
            hi++;
        }

        // Recurse children
        if (node.child) walk(node.child, depth + 1);
        if (node.sibling) walk(node.sibling, depth + 1);
    }

    walk(fiber, 0);
    console.log(`Visited ${visited.size} objects, found ${allObjects.length} with >2 keys`);

    // 2. Filter for interesting objects
    const interesting = allObjects.filter(o =>
        o.keys.some(k => /bird|pipe|score|game|flap|gap|vel|grav|jump|pos|active|start|end|over|crash|hit|alive|dead|fly|canv/i.test(k))
    );

    if (interesting.length > 0) {
        console.log('\n=== INTERESTING OBJECTS ===');
        for (const o of interesting) {
            console.log(`\n[depth=${o.depth}, hook=${o.hook}] keys: {${o.keys.join(', ')}}`);
            for (const k of o.keys) {
                const v = o.obj[k];
                if (v !== undefined && v !== null) {
                    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v}`);
                }
            }
        }
    }

    // 3. Also check all objects with numeric 'y' and 'x' keys
    const posObjects = allObjects.filter(o =>
        o.keys.includes('y') && o.keys.includes('x') && o.keys.length < 15
    );
    if (posObjects.length > 0) {
        console.log('\n=== POSITION OBJECTS (x,y) ===');
        for (const o of posObjects.slice(0, 10)) {
            console.log(`[depth=${o.depth}] {${o.keys.join(', ')}}`, o.obj);
        }
    }

    // 4. Check for refs with 'current' containing game data
    const refs = allObjects.filter(o => o.ref && o.keys.length > 3);
    if (refs.length > 0) {
        console.log('\n=== REFS WITH >3 KEYS ===');
        for (const o of refs.slice(0, 10)) {
            console.log(`[depth=${o.depth}] {${o.keys.join(', ')}}`, o.ref);
        }
    }

    // 5. Dump ALL objects for manual inspection
    console.log('\n=== ALL OBJECTS (for manual inspection) ===');
    for (const o of allObjects.slice(0, 50)) {
        console.log(`[d=${o.depth} h=${o.hook}] {${o.keys.slice(0, 8).join(', ')}}`);
    }

    console.log('\n=== Done ===');
})();
