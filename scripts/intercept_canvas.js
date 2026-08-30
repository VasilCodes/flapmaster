/**
 * Canvas Drawing Interceptor
 * Paste in browser console on greenpump.xyz/flappy BEFORE starting a round
 * Captures all canvas operations to reverse-engineer game logic
 */
(() => {
    console.log('=== Canvas Drawing Interceptor ===\n');

    const canvas = document.querySelector('canvas');
    if (!canvas) { console.log('No canvas found'); return; }

    const ctx = canvas.getContext('2d');
    if (!ctx) { console.log('No 2D context'); return; }

    // Store original methods
    const orig = {
        fillRect: ctx.fillRect.bind(ctx),
        clearRect: ctx.clearRect.bind(ctx),
        drawImage: ctx.drawImage.bind(ctx),
        fill: ctx.fill.bind(ctx),
        stroke: ctx.stroke.bind(ctx),
        beginPath: ctx.beginPath.bind(ctx),
        moveTo: ctx.moveTo.bind(ctx),
        lineTo: ctx.lineTo.bind(ctx),
        arc: ctx.arc.bind(ctx),
        fillStyle: null,
        strokeStyle: null,
        font: null
    };

    // Intercept fillStyle
    let _fillStyle = '#000';
    Object.defineProperty(ctx, 'fillStyle', {
        get() { return _fillStyle; },
        set(v) { _fillStyle = v; }
    });

    let _strokeStyle = '#000';
    Object.defineProperty(ctx, 'strokeStyle', {
        get() { return _strokeStyle; },
        set(v) { _strokeStyle = v; }
    });

    let _font = '';
    Object.defineProperty(ctx, 'font', {
        get() { return _font; },
        set(v) { _font = v; }
    });

    // Track all drawing operations
    window.__drawLog = [];
    let frameCount = 0;

    // Intercept fillRect (most common for game rendering)
    ctx.fillRect = function(x, y, w, h) {
        // Filter out tiny or huge rects (UI elements)
        if (w > 2 && h > 2 && w < 900 && h < 600) {
            window.__drawLog.push({
                op: 'fillRect',
                x: Math.round(x), y: Math.round(y),
                w: Math.round(w), h: Math.round(h),
                color: _fillStyle,
                frame: frameCount
            });
        }
        return orig.fillRect(x, y, w, h);
    };

    // Intercept clearRect
    ctx.clearRect = function(x, y, w, h) {
        window.__drawLog.push({
            op: 'clearRect',
            x: Math.round(x), y: Math.round(y),
            w: Math.round(w), h: Math.round(h),
            frame: frameCount
        });
        return orig.clearRect(x, y, w, h);
    };

    // Intercept drawImage (bird/pipe sprites)
    ctx.drawImage = function(...args) {
        const img = args[0];
        const sx = args.length > 5 ? args[1] : 0;
        const sy = args.length > 5 ? args[2] : 0;
        const sw = args.length > 5 ? args[3] : img.width || 0;
        const sh = args.length > 5 ? args[4] : img.height || 0;
        const dx = args.length > 5 ? args[5] : args[1] || 0;
        const dy = args.length > 5 ? args[6] : args[2] || 0;
        const dw = args.length > 5 ? args[7] : args[3] || img.width || 0;
        const dh = args.length > 5 ? args[8] : args[4] || img.height || 0;

        window.__drawLog.push({
            op: 'drawImage',
            src: img.src ? img.src.split('/').pop() : 'canvas',
            sx: Math.round(sx), sy: Math.round(sy),
            sw: Math.round(sw), sh: Math.round(sh),
            dx: Math.round(dx), dy: Math.round(dy),
            dw: Math.round(dw), dh: Math.round(dh),
            frame: frameCount
        });
        return orig.drawImage(...args);
    };

    // Intercept fill (for circles, paths)
    ctx.fill = function(...args) {
        window.__drawLog.push({
            op: 'fill',
            rule: args[0] || 'nonzero',
            color: _fillStyle,
            frame: frameCount
        });
        return orig.fill(...args);
    };

    // Intercept arc (bird body, eyes)
    ctx.arc = function(x, y, r, s, e, ccw) {
        window.__drawLog.push({
            op: 'arc',
            x: Math.round(x), y: Math.round(y),
            r: Math.round(r),
            start: parseFloat(s.toFixed(2)),
            end: parseFloat(e.toFixed(2)),
            frame: frameCount
        });
        return orig.arc(x, y, r, s, e, ccw);
    };

    // Intercept beginPath
    ctx.beginPath = function() {
        window.__drawLog.push({ op: 'beginPath', frame: frameCount });
        return orig.beginPath();
    };

    // Intercept fillText (score)
    const origFillText = ctx.fillText.bind(ctx);
    ctx.fillText = function(text, x, y, maxWidth) {
        window.__drawLog.push({
            op: 'fillText',
            text, x: Math.round(x), y: Math.round(y),
            color: _fillStyle, font: _font,
            frame: frameCount
        });
        return maxWidth !== undefined ? origFillText(text, x, y, maxWidth) : origFillText(text, x, y);
    };

    // Count frames via requestAnimationFrame hook
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function(cb) {
        return origRAF(() => {
            frameCount++;
            cb(...arguments);
        });
    };

    console.log('Interceptors installed!');
    console.log('');
    console.log('NOW:');
    console.log('1. Start a round (click START FLIGHT or press button)');
    console.log('2. Let the bird fly and die');
    console.log('3. Run: analyzeGame()');
    console.log('');
    console.log('Or run: window.__drawLog.length to see live draws');

    // Analysis function
    window.analyzeGame = function() {
        const log = window.__drawLog;
        console.log(`\n=== Game Analysis (${log.length} operations) ===\n`);

        // Find fillText calls (score)
        const scores = log.filter(e => e.op === 'fillText' && e.text);
        if (scores.length > 0) {
            console.log('SCORE TEXT:', [...new Set(scores.map(s => s.text))]);
            console.log('Score position:', scores[0]);
        }

        // Find drawImage calls (sprites)
        const images = log.filter(e => e.op === 'drawImage');
        if (images.length > 0) {
            const srcs = [...new Set(images.map(i => i.src))];
            console.log('\nSPRITES USED:', srcs);

            // Track sprite positions over time
            const birdFrames = images.filter(i => i.src.includes('bird') || (i.dw < 80 && i.dh < 80));
            if (birdFrames.length > 0) {
                console.log('\nBIRD TRACKING:');
                for (let i = 0; i < Math.min(birdFrames.length, 30); i++) {
                    const f = birdFrames[i];
                    console.log(`  frame=${f.frame} pos=(${f.dx}, ${f.dy}) size=${f.dw}x${f.dh}`);
                }
            }

            const pipeFrames = images.filter(i => i.dw > 50 && !i.src.includes('bird'));
            if (pipeFrames.length > 0) {
                console.log('\nPIPES:');
                for (let i = 0; i < Math.min(pipeFrames.length, 20); i++) {
                    const f = pipeFrames[i];
                    console.log(`  frame=${f.frame} src=${f.src} dx=${f.dx} dy=${f.dy} size=${f.dw}x${f.dh}`);
                }
            }
        }

        // Find fillRect calls (background, ground)
        const rects = log.filter(e => e.op === 'fillRect');
        if (rects.length > 0) {
            console.log('\nRECTANGLES:');
            const byColor = {};
            for (const r of rects) {
                const key = r.color;
                if (!byColor[key]) byColor[key] = { count: 0, examples: [] };
                byColor[key].count++;
                if (byColor[key].examples.length < 3) byColor[key].examples.push(r);
            }
            for (const [color, data] of Object.entries(byColor)) {
                console.log(`  ${color}: ${data.count} calls`);
                for (const e of data.examples) {
                    console.log(`    (${e.x}, ${e.y}) ${e.w}x${e.h}`);
                }
            }
        }

        // Find arcs (bird body)
        const arcs = log.filter(e => e.op === 'arc');
        if (arcs.length > 0) {
            console.log('\nARCS (bird body?):');
            for (let i = 0; i < Math.min(arcs.length, 20); i++) {
                const a = arcs[i];
                console.log(`  frame=${a.frame} pos=(${a.x}, ${a.y}) r=${a.r}`);
            }
        }

        console.log('\n=== Done ===');
    };
})();
