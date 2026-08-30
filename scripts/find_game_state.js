/**
 * Find Game State in React Fiber
 * Locates the exact ref containing bird, pipes, score, etc.
 * Paste in browser console on greenpump.xyz/flappy DURING a round
 */
(() => {
    console.log('=== Finding Game State ===\n');

    const canvas = document.querySelector('canvas');
    if (!canvas) { console.log('No canvas'); return; }

    const fiberKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber$'));
    if (!fiberKey) { console.log('No fiber'); return; }

    let fiber = canvas[fiberKey];
    let found = null;

    // Walk up the fiber tree looking for refs with bird/pipes
    for (let i = 0; i < 80; i++) {
        if (!fiber) break;

        // Check memoizedState chain for refs
        let hook = fiber.memoizedState;
        let hookIndex = 0;
        while (hook && hookIndex < 30) {
            const s = hook.memoizedState;

            // Check useRef pattern: { current: { bird, pipes, ... } }
            if (s && typeof s === 'object' && s !== null && 'current' in s) {
                const curr = s.current;
                if (curr && typeof curr === 'object') {
                    const keys = Object.keys(curr);
                    // Look for bird + pipes (the game state ref)
                    if (keys.includes('bird') && keys.includes('pipes')) {
                        console.log(`\n*** FOUND GAME STATE at Fiber ${i}, Hook ${hookIndex} ***`);
                        console.log('Keys:', keys);

                        // Print bird state
                        if (curr.bird) {
                            console.log('\nBird:', curr.bird);
                        }

                        // Print pipes
                        if (curr.pipes) {
                            console.log(`\nPipes (${curr.pipes.length}):`);
                            for (let p = 0; p < curr.pipes.length; p++) {
                                const pipe = curr.pipes[p];
                                console.log(`  [${p}] x=${pipe.x?.toFixed(1)} topH=${pipe.topH} bottomY=${pipe.bottomY} gap=${(pipe.bottomY - pipe.topH)} passed=${pipe.passed}`);
                            }
                        }

                        // Print other state
                        console.log('\nOther state:');
                        for (const k of keys) {
                            if (k !== 'bird' && k !== 'pipes') {
                                const v = curr[k];
                                if (typeof v !== 'function' && typeof v !== 'object') {
                                    console.log(`  ${k}: ${v}`);
                                }
                            }
                        }

                        // Also check activeConfig
                        if (curr.activeConfig) {
                            console.log('\nActive config:', curr.activeConfig);
                        }

                        found = { fiber: i, hook: hookIndex, state: curr };
                        break;
                    }
                }
            }

            // Also check if s itself has bird/pipes (non-ref pattern)
            if (s && typeof s === 'object' && s !== null && !('current' in s)) {
                const keys = Object.keys(s);
                if (keys.includes('bird') && keys.includes('pipes')) {
                    console.log(`\n*** FOUND GAME STATE (direct) at Fiber ${i}, Hook ${hookIndex} ***`);
                    console.log('Keys:', keys);
                    if (s.bird) console.log('Bird:', s.bird);
                    if (s.pipes) {
                        console.log(`Pipes (${s.pipes.length}):`);
                        for (let p = 0; p < s.pipes.length; p++) {
                            const pipe = s.pipes[p];
                            console.log(`  [${p}] x=${pipe.x?.toFixed(1)} topH=${pipe.topH} bottomY=${pipe.bottomY}`);
                        }
                    }
                    found = { fiber: i, hook: hookIndex, state: s };
                    break;
                }
            }

            hook = hook.next;
            hookIndex++;
        }

        if (found) break;
        fiber = fiber.return;
    }

    if (!found) {
        console.log('Game state not found in fiber tree.');
        console.log('\nTrying: scan all objects on window...');

        // Try finding via global search
        let searched = new Set();
        function search(obj, path, depth) {
            if (!obj || depth > 3 || searched.has(obj)) return;
            searched.add(obj);
            try {
                const keys = Object.keys(obj);
                if (keys.includes('bird') && keys.includes('pipes')) {
                    console.log(`Found at ${path}:`, obj);
                    return obj;
                }
                for (const k of keys) {
                    if (typeof obj[k] === 'object' && obj[k] !== null) {
                        const result = search(obj[k], `${path}.${k}`, depth + 1);
                        if (result) return result;
                    }
                }
            } catch(e) {}
        }

        // Search common React roots
        const roots = document.querySelectorAll('[data-reactroot], #__next, #root');
        for (const root of roots) {
            const rKey = Object.keys(root).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
            if (rKey) {
                search(root[rKey], 'root', 0);
            }
        }
    }

    // Store for later use
    if (found) {
        window.__gameState = found.state;
        console.log('\n=== Stored as window.__gameState ===');
        console.log('Access via: window.__gameState.bird, window.__gameState.pipes, etc.');
    }

    console.log('\n=== Done ===');
})();
