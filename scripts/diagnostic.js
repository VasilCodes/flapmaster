// GreenPump Flappy - Browser Diagnostic Script
// Paste this into the console while on https://greenpump.xyz/flappy
// Then copy the output and share it.

(function() {
    const R = {};
    R.url = location.href;
    R.userAgent = navigator.userAgent;
    R.timestamp = new Date().toISOString();

    // 1. Canvas
    const canvases = document.querySelectorAll('canvas');
    R.canvasCount = canvases.length;
    R.canvases = [];
    canvases.forEach((c, i) => {
        R.canvases.push({
            index: i,
            id: c.id,
            width: c.width,
            height: c.height,
            className: c.className,
            parentClass: c.parentElement?.className,
            hasContext: !!c.getContext('2d')
        });
    });

    // 2. Window globals (game-related)
    const gameKeys = ['game', '__game', '__gameState', 'gameInstance', 'flappyGame',
        'GAME', 'Game', 'app', '__NEXT_DATA__', '__next', 'ee', 'gameRef'];
    R.windowGlobals = {};
    gameKeys.forEach(k => {
        if (window[k] !== undefined) {
            R.windowGlobals[k] = typeof window[k];
            if (typeof window[k] === 'object' && window[k]) {
                R.windowGlobals[k + '_keys'] = Object.keys(window[k]).slice(0, 20);
            }
        }
    });

    // 3. React Fiber Tree
    R.reactFiber = 'checking...';
    try {
        const root = document.getElementById('__next');
        if (root) {
            const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber'));
            if (fiberKey) {
                R.reactFiber = 'found at #__next.' + fiberKey;
                // Try to traverse to find game state
                let fiber = root[fiberKey];
                let found = [];
                let depth = 0;
                while (fiber && depth < 50) {
                    if (fiber.memoizedState) {
                        const state = fiber.memoizedState;
                        if (state.memoizedState && typeof state.memoizedState === 'object') {
                            const keys = Object.keys(state.memoizedState);
                            if (keys.includes('bird') || keys.includes('pipes') || keys.includes('active')) {
                                found.push({depth, keys: keys.slice(0, 15), type: fiber.type?.name || fiber.type || 'unknown'});
                            }
                        }
                    }
                    if (fiber.memoizedProps) {
                        const props = fiber.memoizedProps;
                        if (props.bird || props.pipes || props.gameState) {
                            found.push({depth, propKeys: Object.keys(props).slice(0, 15), type: fiber.type?.name || fiber.type || 'unknown'});
                        }
                    }
                    fiber = fiber.child || fiber.sibling || fiber.return?.sibling;
                    depth++;
                }
                R.reactGameRefs = found;
            } else {
                R.reactFiber = 'no fiber key found on #__next';
            }
        } else {
            R.reactFiber = 'no #__next element';
        }
    } catch(e) {
        R.reactFiber = 'error: ' + e.message;
    }

    // 4. DOM Structure (flappy-arena-grid)
    R.arenaGrid = null;
    try {
        const grid = document.querySelector('.flappy-arena-grid');
        if (grid) {
            R.arenaGrid = {
                found: true,
                childCount: grid.children.length,
                innerHTML_preview: grid.innerHTML.substring(0, 500)
            };
        } else {
            R.arenaGrid = {found: false};
        }
    } catch(e) {
        R.arenaGrid = {error: e.message};
    }

    // 5. Buttons
    R.buttons = [];
    document.querySelectorAll('button').forEach((btn, i) => {
        const text = (btn.innerText || '').trim();
        if (text.length > 0 && text.length < 100) {
            R.buttons.push({
                index: i,
                text: text,
                disabled: btn.disabled,
                className: btn.className.substring(0, 80),
                parentClass: btn.parentElement?.className?.substring(0, 80)
            });
        }
    });

    // 6. Score elements
    R.scoreElements = [];
    const scoreSelectors = ['.score', '[class*="score"]', '[class*="Score"]', '[data-testid*="score"]'];
    scoreSelectors.forEach(sel => {
        try {
            document.querySelectorAll(sel).forEach(el => {
                R.scoreElements.push({
                    selector: sel,
                    tag: el.tagName,
                    text: (el.innerText || '').substring(0, 50),
                    className: el.className?.substring(0, 80)
                });
            });
        } catch(e) {}
    });

    // 7. Input fields
    R.inputs = [];
    document.querySelectorAll('input').forEach((inp, i) => {
        R.inputs.push({
            index: i,
            type: inp.type,
            value: inp.value,
            placeholder: inp.placeholder,
            className: inp.className?.substring(0, 80),
            disabled: inp.disabled
        });
    });

    // 8. Overlay detection
    R.overlayCheck = {};
    const overlayTexts = ['Ready for Flight', 'START FLIGHT', 'CASH OUT', 'FLIGHT CRASHED', 'CASHED OUT'];
    overlayTexts.forEach(text => {
        const el = Array.from(document.querySelectorAll('*')).find(e => e.innerText?.includes(text) && e.children.length < 5);
        R.overlayCheck[text] = el ? {
            found: true,
            tag: el.tagName,
            visible: getComputedStyle(el).display !== 'none',
            className: el.className?.substring(0, 80)
        } : {found: false};
    });

    // 9. Wallet status
    R.wallet = {
        hasPhantom: !!window.solana,
        hasPhantomIsPhantom: !!(window.solana?.isPhantom),
        connected: !!(window.solana?.isConnected),
        publicKey: window.solana?.publicKey?.toString() || null
    };

    // 10. Check for fetch monkey-patching potential
    R.fetchAvailable = typeof fetch === 'function';

    // 11. All window keys that might be game-related (filter)
    R.potentialGameKeys = [];
    const skipKeys = new Set(['location','chrome','opr','__coverage__','__core-js_shared__',
        'performance','navigator','screen','history','frames','self','top','parent',
        'open','close','alert','confirm','prompt','print','fetch','XMLHttpRequest',
        'Request','Response','Headers','URL','Blob','File','FormData','ReadableStream',
        'WritableStream','TransformStream','AbortController','AbortSignal','EventTarget',
        'Event','CustomEvent','Node','Element','HTMLElement','Document','MutationObserver',
        'IntersectionObserver','ResizeObserver','requestAnimationFrame','cancelAnimationFrame',
        'setTimeout','setInterval','clearTimeout','clearInterval','matchMedia','getComputedStyle']);
    for (const key in window) {
        if (skipKeys.has(key)) continue;
        try {
            const val = window[key];
            const t = typeof val;
            if (t === 'object' && val !== null && !Array.isArray(val)) {
                const objKeys = Object.keys(val);
                if (objKeys.length > 0 && objKeys.length < 50) {
                    const hasGameLike = objKeys.some(k => 
                        ['bird','pipe','score','game','flap','canvas','active','playing','cashout'].includes(k.toLowerCase())
                    );
                    if (hasGameLike) {
                        R.potentialGameKeys.push({key, objKeys: objKeys.slice(0, 20)});
                    }
                }
            }
        } catch(e) {}
    }

    // 12. Flappy arena children deep scan
    R.arenaDeepScan = [];
    try {
        const grid = document.querySelector('.flappy-arena-grid');
        if (grid) {
            function scan(el, depth, path) {
                if (depth > 6) return;
                const info = {
                    tag: el.tagName,
                    class: el.className?.toString().substring(0, 60) || '',
                    id: el.id || '',
                    children: el.children.length,
                    hasCanvas: el.tagName === 'CANVAS',
                    text: el.children.length === 0 ? (el.innerText || '').substring(0, 40) : ''
                };
                if (info.hasCanvas) {
                    info.canvasWidth = el.width;
                    info.canvasHeight = el.height;
                }
                R.arenaDeepScan.push({path, ...info});
                Array.from(el.children).forEach((child, i) => {
                    scan(child, depth + 1, path + '>' + (child.tagName || '?') + '[' + i + ']');
                });
            }
            scan(grid, 0, 'grid');
        }
    } catch(e) {
        R.arenaDeepScan = 'error: ' + e.message;
    }

    // Output
    const output = JSON.stringify(R, null, 2);
    console.log('=== GREENPUMP DIAGNOSTIC START ===');
    console.log(output);
    console.log('=== GREENPUMP DIAGNOSTIC END ===');

    // Also copy to clipboard if possible
    try {
        navigator.clipboard.writeText(output).then(() => {
            console.log('[DIAGNOSTIC] Output copied to clipboard!');
        });
    } catch(e) {
        console.log('[DIAGNOSTIC] Clipboard write failed. Please manually copy the JSON above.');
    }

    return R;
})();
