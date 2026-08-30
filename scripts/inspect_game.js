/**
 * Game State Inspector
 * Paste in browser console on greenpump.xyz/flappy
 * Read-only - just inspects, doesn't modify anything
 */
(() => {
    console.log('=== Game State Inspector ===\n');

    // 1. Find canvas
    const canvas = document.querySelector('canvas');
    if (!canvas) { console.log('No canvas found'); return; }
    console.log(`Canvas: ${canvas.width}x${canvas.height}`);

    // 2. Find React fiber
    const fiberKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber$'));
    if (!fiberKey) { console.log('No React fiber found on canvas'); return }
    
    let fiber = canvas[fiberKey];
    console.log(`Fiber key: ${fiberKey}`);

    // 3. Walk up the fiber tree looking for game state
    console.log('\n--- Walking fiber tree (up to 30 levels) ---');
    let current = fiber;
    let found = [];
    
    for (let i = 0; i < 30; i++) {
        if (!current) break;
        
        // Check memoizedState (hooks)
        let hook = current.memoizedState;
        let hookIndex = 0;
        while (hook && hookIndex < 20) {
            const q = hook.queue;
            const s = hook.memoizedState;
            
            if (s && typeof s === 'object' && s !== null) {
                const keys = Object.keys(s);
                const interesting = keys.filter(k => 
                    /bird|pipe|score|game|flap|gap|vel|gravity|jump|pos|y|x|speed|active|state/i.test(k)
                );
                
                if (interesting.length > 0) {
                    console.log(`\n[Fiber ${i}, Hook ${hookIndex}] Found: {${interesting.join(', ')}}`);
                    for (const k of interesting) {
                        console.log(`  ${k}:`, s[k]);
                    }
                    found.push({ fiber: i, hook: hookIndex, keys: interesting, obj: s });
                }
            }
            
            // Also check ref objects
            if (s && typeof s === 'object' && s !== null && s.hasOwnProperty('current')) {
                const curr = s.current;
                if (curr && typeof curr === 'object') {
                    const keys = Object.keys(curr);
                    const interesting = keys.filter(k => 
                        /bird|pipe|score|game|flap|gap|vel|gravity|jump|pos|y|x|speed|active|state/i.test(k)
                    );
                    if (interesting.length > 0) {
                        console.log(`\n[Fiber ${i}, Hook ${hookIndex}] useRef.current {${interesting.join(', ')}}`);
                        for (const k of interesting) {
                            console.log(`  ${k}:`, curr[k]);
                        }
                        found.push({ fiber: i, hook: hookIndex, type: 'ref', keys: interesting, obj: curr });
                    }
                }
            }
            
            hook = hook.next;
            hookIndex++;
        }
        
        // Check stateNode
        if (current.stateNode && current.stateNode !== canvas) {
            const st = current.stateNode;
            if (st.state && typeof st.state === 'object') {
                const keys = Object.keys(st.state);
                const interesting = keys.filter(k => 
                    /bird|pipe|score|game|flap|gap|vel|gravity|jump|pos|y|x|speed|active|state/i.test(k)
                );
                if (interesting.length > 0) {
                    console.log(`\n[Fiber ${i}] ClassState {${interesting.join(', ')}}`);
                    for (const k of interesting) {
                        console.log(`  ${k}:`, st.state[k]);
                    }
                    found.push({ fiber: i, type: 'classState', keys: interesting, obj: st.state });
                }
            }
        }
        
        current = current.return;
    }

    // 4. Try to find game state via window/global
    console.log('\n--- Checking window for game state ---');
    const gameKeys = Object.keys(window).filter(k => 
        /game|flappy|bird|pipe|state/i.test(k)
    );
    if (gameKeys.length > 0) {
        console.log('Found:', gameKeys);
        for (const k of gameKeys) {
            console.log(`  window.${k}:`, typeof window[k], window[k]);
        }
    } else {
        console.log('No game-related window globals found');
    }

    // 5. Check React DevTools hook
    console.log('\n--- Checking React DevTools hook ---');
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        console.log('React DevTools hook exists');
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (hook.renderers) {
            console.log('Renderers:', Object.keys(hook.renderers).length);
        }
    }

    // 6. Summary
    console.log('\n=== Summary ===');
    if (found.length > 0) {
        console.log(`Found ${found.length} objects with game-related keys`);
        console.log('Most promising:', found[0]);
    } else {
        console.log('No game state found in fiber tree.');
        console.log('The game might use plain refs or non-standard naming.');
        console.log('Try: document.querySelector("canvas").__reactFiber$... manually');
    }

    return found;
})();
