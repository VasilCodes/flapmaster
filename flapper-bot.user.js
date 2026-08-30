// ==UserScript==
// @name         FlapMaster – Auto-Flap Bot (GreenPump)
// @namespace    http://tampermonkey.net/
// @version      5.5
// @description  Auto-flap bot. Detects bird position via canvas, flaps and cashes out with keyboard simulation.
// @author       zavko & limerence
// @match        https://greenpump.xyz/flappy*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    window.Flapper = { showPanel: null, getConfig: null, name: 'FlapMaster' };

    // ==================== CONFIGURATION ====================
    const CONFIG = {
        targetPipes: 3,
        preset: 'CASUAL_PLAYER',
        customAccuracy: 0.65,
        customMissChance: 0.15,
        customDelayVariance: 60,
        customMinInterval: 70,
        debugMode: false,
    };

    // Game physics (EXACT from source: 41qzff47zxjhm.js)
    // Bot behavior profiles
    const PROFILES = {
        PERFECT_BOT:   { flapAccuracy: 0.98, missChance: 0.01, delayVariance: 5,   minInterval: 50 },
        HUMAN_PRO:     { flapAccuracy: 0.85, missChance: 0.05, delayVariance: 25,  minInterval: 60 },
        CASUAL_PLAYER: { flapAccuracy: 0.65, missChance: 0.15, delayVariance: 60,  minInterval: 70 },
        DRUNK_MODE:    { flapAccuracy: 0.40, missChance: 0.35, delayVariance: 150, minInterval: 90 },
        CHAOS:         { flapAccuracy: 0.10, missChance: 0.60, delayVariance: 300, minInterval: 120 },
        CUSTOM:        { flapAccuracy: 0.65, missChance: 0.15, delayVariance: 60,  minInterval: 70 }
    };

    // Multiplier calculation (EXACT from source)
    function getMultiplier(difficulty, pipes) {
        if (pipes <= 0) return 1;
        if (pipes === 1) return 1.05;
        if (pipes === 2) return 1.07;
        if (pipes === 3) return 1.1;
        const base = difficulty === 'chill' ? 1.15 : difficulty === 'pump' ? 1.2 : 1.25;
        const step = difficulty === 'chill' ? 0.15 : difficulty === 'pump' ? 0.2 : 0.25;
        return Number((base + (pipes - 4) * step).toFixed(2));
    }

    // Dynamic difficulty (EXACT from source)
    function getDynamicGap(baseGap, pipesPassed, formState) {
        let gap = Math.max(91, Math.round(
            baseGap - 3 * !!('hot' === formState) - Math.min(6, 0.19 * pipesPassed)
        ));
        return gap;
    }

    function getDynamicSpeed(baseSpeed, pipesPassed) {
        return Number((baseSpeed + Math.min(0.55, 0.028 * pipesPassed)).toFixed(2));
    }

    function getDynamicSpacing(baseSpacing, pipesPassed) {
        return Math.max(186, Math.round(baseSpacing - Math.min(10, 0.29 * pipesPassed)));
    }

    // Canvas dimensions (from source)
    const CANVAS_W = 940;
    const CANVAS_H = 580;
    const GROUND_Y = 490; // canvasH - 90
    const BIRD_RADIUS = 13;
    const PIPE_WIDTH = 68;
    const PIPE_CAP = 28;

    // Physics constants (EXACT from source)
    const DIFFICULTY = {
        chill: { gap: 114, speed: 3.31, gravity: 0.28, jumpForce: -6.1, pipeSpacing: 203, maxFallSpeed: 6.6 },
        pump:  { gap: 110, speed: 3.44, gravity: 0.29, jumpForce: -6.2, pipeSpacing: 201, maxFallSpeed: 6.8 },
        degen: { gap: 105, speed: 3.59, gravity: 0.3, jumpForce: -6.3, pipeSpacing: 198, maxFallSpeed: 7.0 }
    };

    // ==================== STATE ====================
    let state = {
        running: false,
        roundActive: false,
        currentScore: 0,
        birdY: 0,
        birdX: 0,
        birdVelocity: 0,
        lastBirdUpdateTime: 0,
        lastFlapTime: 0,
        cashoutPending: false,
        birdHistory: [],
        detectionFrames: 0,
        crashRequested: false,
        overlayDetected: false,
        roundStartLogged: false,
    };

    let stats = {
        roundsPlayed: 0,
        roundsWon: 0,
        bestScore: 0,
        cashouts: 0,
    };

    let canvas, ctx;
    const logEntries = [];

    // ==================== LOGGING ====================
    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        const entry = `[${ts}] ${msg}`;
        logEntries.push(entry);
        const logDiv = document.getElementById('fp-log');
        if (logDiv) {
            logDiv.innerHTML = logEntries.slice(-60).join('<br>');
            logDiv.scrollTop = logDiv.scrollHeight;
        }
        console.log('[FLAPMASTER]', msg);
    }

    function debugLog(msg) {
        if (CONFIG.debugMode) console.log('[DEBUG]', msg);
    }

    // ==================== KEY SIMULATION ====================
    function simulateKey(key) {
        const code = key === ' ' ? 'Space' : key === 'c' || key === 'C' ? 'KeyC' : 'Enter';
        const keyCode = key === ' ' ? 32 : key === 'c' || key === 'C' ? 67 : 13;
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key, code, keyCode, which: keyCode, bubbles: true, cancelable: true
        }));
        setTimeout(() => {
            document.dispatchEvent(new KeyboardEvent('keyup', {
                key, code, keyCode, bubbles: true
            }));
        }, 50);
    }

    // ==================== MULTIPLIER ====================
    function getProfile() {
        if (CONFIG.preset === 'CUSTOM') {
            return {
                flapAccuracy: CONFIG.customAccuracy,
                missChance: CONFIG.customMissChance,
                delayVariance: CONFIG.customDelayVariance,
                minInterval: CONFIG.customMinInterval
            };
        }
        return PROFILES[CONFIG.preset] || PROFILES.CASUAL_PLAYER;
    }

    // ==================== ELEMENT FINDING ====================
    function findCanvas() {
        const c = document.querySelector('canvas');
        if (c && c.width > 0 && c.height > 0) return c;
        return null;
    }

    function findStartButton() {
        for (const btn of document.querySelectorAll('button')) {
            if ((btn.innerText || '').trim().startsWith('START FLIGHT')) return btn;
        }
        return null;
    }

    // ==================== OVERLAY DETECTION ====================
    function isOverlayVisible() {
        // Check for "Ready for Flight" text
        for (const el of document.querySelectorAll('.flappy-arena-grid *')) {
            if (el.innerText && el.innerText.includes('Ready for Flight') && el.children.length < 5) {
                const style = getComputedStyle(el);
                if (style.display !== 'none' && style.opacity !== '0') return true;
            }
        }
        // Check if START FLIGHT button is visible
        const btn = findStartButton();
        if (btn) {
            const style = getComputedStyle(btn);
            if (style.display !== 'none' && style.opacity !== '0') return true;
        }
        return false;
    }

    // ==================== ROUND DETECTION ====================
    function isRoundActive() {
        if (isOverlayVisible()) {
            if (!state.overlayDetected) {
                state.overlayDetected = true;
                log('Overlay visible - waiting...');
            }
            return false;
        }
        if (state.overlayDetected) {
            state.overlayDetected = false;
            log('Overlay gone - waiting for bird...');
        }

        // Check for game over
        for (const sel of ['.game-over', '[class*="gameover"]', '[class*="crashed"]']) {
            const el = document.querySelector(sel);
            if (el && getComputedStyle(el).display !== 'none') return false;
        }

        // Read bird position from canvas
        if (!readBirdPosition()) {
            state.detectionFrames++;
            if (state.detectionFrames > 60) return false;
            return false;
        }
        state.detectionFrames = 0;

        // Track bird movement to detect active round
        state.birdHistory.push(state.birdY);
        if (state.birdHistory.length > 10) state.birdHistory.shift();

        if (state.birdHistory.length >= 5) {
            const min = Math.min(...state.birdHistory);
            const max = Math.max(...state.birdHistory);
            if (max - min > 5) {
                if (!state.roundStartLogged) {
                    log('Round active!');
                    state.roundStartLogged = true;
                }
                return true;
            }
        }
        return false;
    }

    // ==================== BIRD POSITION (Canvas) ====================
    // Bird is bright lime green (~RGB 120, 220, 80), small cluster (~20-50px)
    // Bushes/trees are darker green (~RGB 80, 140, 60), large clusters
    // Use size + color to distinguish bird from background
    function readBirdPosition() {
        if (!canvas || !ctx) return false;

        try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const w = canvas.width;
            const h = canvas.height;

            // Pass 1: Find all bright green pixel clusters
            // Bird = bright lime: G>180, R<120, B<90, G-R>60
            // Exclude bottom 80px (ground) and very top (sky)
            let clusters = [];
            let visited = new Uint8Array(w * h);

            for (let y = 60; y < h - 80; y += 3) {
                for (let x = 50; x < w * 0.4; x += 3) {
                    const idx = (y * w + x) * 4;
                    const r = data[idx], g = data[idx+1], b = data[idx+2];

                    // Strict bird color: bright lime green
                    if (g < 180 || r > 120 || b > 90 || (g - r) < 60) continue;
                    if (visited[y * w + x]) continue;

                    // Flood-fill cluster
                    let pixels = [];
                    let stack = [[x, y]];
                    while (stack.length > 0 && pixels.length < 200) {
                        const [cx, cy] = stack.pop();
                        if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
                        const ci = (cy * w + cx) * 4;
                        if (visited[cy * w + cx]) continue;
                        if (data[ci+1] < 180 || data[ci] > 120 || data[ci+2] > 90 || (data[ci+1] - data[ci]) < 60) continue;
                        visited[cy * w + cx] = 1;
                        pixels.push({ x: cx, y: cy });
                        stack.push([cx+3, cy], [cx-3, cy], [cx, cy+3], [cx, cy-3]);
                    }

                    // Bird cluster: 15-150 pixels (bushes are 500+)
                    if (pixels.length >= 15 && pixels.length <= 150) {
                        let sumX = 0, sumY = 0;
                        for (const p of pixels) { sumX += p.x; sumY += p.y; }
                        clusters.push({
                            x: sumX / pixels.length,
                            y: sumY / pixels.length,
                            size: pixels.length
                        });
                    }
                }
            }

            if (clusters.length === 0) return false;

            // Pick the cluster closest to canvas center Y (bird starts ~center)
            const centerY = h / 2;
            clusters.sort((a, b) => Math.abs(a.y - centerY) - Math.abs(b.y - centerY));
            const best = clusters[0];

            // Track velocity (change in Y over time)
            const prevY = state.birdY;
            const prevTime = state.lastBirdUpdateTime || now;
            const dt = (now - prevTime) / 1000;
            if (dt > 0 && dt < 0.5) {
                state.birdVelocity = (best.y - prevY) / dt;
            }
            state.lastBirdUpdateTime = now;

            state.birdY = best.y;
            state.birdX = best.x;
            debugLog(`Bird: (${best.x.toFixed(0)}, ${best.y.toFixed(0)}) vel=${state.birdVelocity.toFixed(1)} [${best.size}px, ${clusters.length} clusters]`);
            return true;
        } catch (e) {
            debugLog(`Canvas error: ${e.message}`);
            return false;
        }
    }

    // ==================== PIPE DETECTION (Canvas) ====================
    // Pipes are dark teal/green columns (RGB ~50-100, 120-180, 80-140)
    // Scan vertical columns in right half of canvas for dark pixels
    function readPipes() {
        if (!canvas || !ctx) return [];

        try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const w = canvas.width;
            const h = canvas.height;
            const groundY = GROUND_Y; // 490

            // Scan x positions in right half (where pipes are)
            let pipes = [];
            for (let x = w * 0.3; x < w - 20; x += 5) {
                // Count dark vertical pixels in this column
                let darkCount = 0;
                let darkYs = [];
                for (let y = 30; y < groundY; y += 3) {
                    const idx = (y * w + x) * 4;
                    const r = data[idx], g = data[idx+1], b = data[idx+2];
                    // Pipe color: dark teal/green (not sky, not bird, not ground)
                    if (r < 120 && g > 80 && g < 200 && b > 60 && b < 180 && g > r) {
                        darkCount++;
                        darkYs.push(y);
                    }
                }

                // A pipe column has many dark pixels (at least 30% of playable height)
                if (darkCount > 20 && darkYs.length > 0) {
                    // Check if this x is close to an existing pipe (merge)
                    let merged = false;
                    for (const p of pipes) {
                        if (Math.abs(p.x - x) < 20) {
                            merged = true;
                            break;
                        }
                    }
                    if (!merged) {
                        // Find the gap (where dark pixels stop)
                        darkYs.sort((a, b) => a - b);
                        let gaps = [];
                        for (let i = 1; i < darkYs.length; i++) {
                            if (darkYs[i] - darkYs[i-1] > 30) {
                                gaps.push({
                                    top: darkYs[i-1],
                                    bottom: darkYs[i],
                                    center: (darkYs[i-1] + darkYs[i]) / 2
                                });
                            }
                        }
                        if (gaps.length > 0) {
                            pipes.push({
                                x: x,
                                gapCenter: gaps[0].center,
                                gapTop: gaps[0].top,
                                gapBottom: gaps[0].bottom,
                                gapSize: gaps[0].bottom - gaps[0].top
                            });
                        }
                    }
                }
            }

            // Sort by x position (closest to bird first)
            const birdX = state.birdX || 120;
            pipes.sort((a, b) => a.x - b.x);

            // Only return pipes ahead of the bird
            pipes = pipes.filter(p => p.x > birdX - 20);

            debugLog(`Pipes: ${pipes.length} [${pipes.map(p => `x=${p.x.toFixed(0)} gap=${p.gapCenter.toFixed(0)}`).join(', ')}]`);
            return pipes.slice(0, 5); // Return at most 5 pipes
        } catch (e) {
            debugLog(`Pipe detection error: ${e.message}`);
            return [];
        }
    }

    // ==================== CASHOUT ====================
    function cashOut() {
        if (state.cashoutPending) return;
        state.cashoutPending = true;
        const mult = getMultiplier(CONFIG.difficulty || 'chill', state.currentScore);
        log(`Cashout triggered (${mult}x) at score ${state.currentScore}`);
        stats.cashouts++;

        // Try KEY C first, then ENTER
        simulateKey('c');
        setTimeout(() => simulateKey('Enter'), 200);

        // Retry after 2s
        const retryTimer = setTimeout(() => {
            if (state.cashoutPending) {
                log('Retrying cashout...');
                simulateKey('c');
                setTimeout(() => simulateKey('Enter'), 200);
            }
        }, 2000);

        // Monitor for game over
        let checkCount = 0;
        const checkEnd = setInterval(() => {
            checkCount++;
            const gameOver = document.querySelector('.game-over, [class*="crashed"], [class*="gameover"]');
            if ((gameOver && getComputedStyle(gameOver).display !== 'none') || checkCount > 30) {
                clearInterval(checkEnd);
                clearTimeout(retryTimer);
                if (state.cashoutPending) {
                    state.cashoutPending = false;
                    state.roundActive = false;
                    stats.roundsPlayed++;
                    if (state.currentScore >= CONFIG.targetPipes) stats.roundsWon++;
                    if (state.currentScore > stats.bestScore) stats.bestScore = state.currentScore;
                    log(`Round finished. Score: ${state.currentScore} | Won: ${stats.roundsWon}/${stats.roundsPlayed}`);
                    state.roundStartLogged = false;
                    updateStatsDisplay();

    // Remove auto-restart references
    if (CONFIG.autoRestart) {
        log('Auto-restart: monitoring...');
        scheduleAutoRestart();
    } else {
        log('Start next round manually.');
    }
                }
            }
        }, 500);

        // Hard timeout
        setTimeout(() => {
            clearInterval(checkEnd);
            clearTimeout(retryTimer);
            if (state.cashoutPending) {
                state.cashoutPending = false;
                state.roundActive = false;
                log('Cashout timeout - check Phantom.');
            }
        }, 15000);
    }

    // ==================== GAME LOOP ====================
    function gameLoop() {
        if (!state.running) {
            requestAnimationFrame(gameLoop);
            return;
        }

        const active = isRoundActive();
        if (!active) {
            if (state.roundActive) {
                state.roundActive = false;
                log(`Round ended. Score: ${state.currentScore}`);
                state.roundStartLogged = false;
            }
            requestAnimationFrame(gameLoop);
            return;
        }

        if (!state.roundActive) {
            state.roundActive = true;
            state.currentScore = 0;
            state.birdHistory = [];
            state.crashRequested = false;
            state.roundStartLogged = false;
            log(`Round started! Target: ${CONFIG.targetPipes} pipes (${getMultiplier(CONFIG.difficulty || 'chill', CONFIG.targetPipes)}x)`);
            simulateKey(' ');
            state.lastFlapTime = Date.now();
        }

        // Check target reached
        if (state.currentScore >= CONFIG.targetPipes && !state.cashoutPending) {
            cashOut();
            requestAnimationFrame(gameLoop);
            return;
        }

        if (state.crashRequested) {
            requestAnimationFrame(gameLoop);
            return;
        }

        const profile = getProfile();
        const { flapAccuracy, missChance, delayVariance, minInterval } = profile;
        const now = Date.now();

        // Detect pipes from canvas
        const pipes = readPipes();
        const birdY = state.birdY;
        const birdX = state.birdX || 120;
        const config = DIFFICULTY[CONFIG.difficulty || 'chill'];

        // Find the next pipe (closest ahead of bird)
        let targetY = GROUND_Y / 2; // default: center of play area
        if (pipes.length > 0) {
            // Find the pipe the bird is approaching
            let nextPipe = null;
            for (const p of pipes) {
                if (p.x > birdX - 30) {
                    nextPipe = p;
                    break;
                }
            }
            if (nextPipe) {
                targetY = nextPipe.gapCenter;
                debugLog(`Target: pipe at x=${nextPipe.x.toFixed(0)}, gap center=${nextPipe.gapCenter.toFixed(0)}`);
            }
        }

        // Calculate flap decision
        const gapTop = nextPipe.gapTop;
        const gapBottom = nextPipe.gapBottom;

        // Account for pipe caps (28px each side) - safe zone is smaller
        const safeTop = gapTop + PIPE_CAP;
        const safeBottom = gapBottom - PIPE_CAP;

        // Target: upper 40% of safe zone (bird spends more time falling than rising)
        const targetY = safeTop + (safeBottom - safeTop) * 0.4;

        debugLog(`birdY=${birdY.toFixed(0)} target=${targetY.toFixed(0)} safe=[${safeTop.toFixed(0)}-${safeBottom.toFixed(0)}] vy=${state.birdVelocity.toFixed(1)}`);

        if (now - state.lastFlapTime > minInterval) {
            let shouldFlap = false;
            if (birdY > GROUND_Y - 80) {
                shouldFlap = true;
            } else if (birdY > targetY && state.birdVelocity >= 0) {
                shouldFlap = true;
            }

            if (shouldFlap) {
                if (Math.random() < missChance) {
                    debugLog('Miss chance - skip');
                } else {
                    simulateKey(' ');
                    state.lastFlapTime = now;
                }
            }
        }

        requestAnimationFrame(gameLoop);
    }

    // ==================== UI PANEL ====================
    function createPanel() {
        const old = document.getElementById('flapper-panel');
        if (old) old.remove();

        const style = document.createElement('style');
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
            #flapper-panel * { box-sizing: border-box; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; }
            #flapper-panel {
                position: fixed; top: 20px; right: 20px; width: 280px; max-height: 92vh;
                overflow-y: auto; background: rgba(10, 14, 18, 0.88);
                backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
                color: #e6edf3; border-radius: 16px; padding: 14px 14px 12px;
                box-shadow: 0 0 30px rgba(0, 255, 170, 0.08), 0 20px 60px rgba(0,0,0,0.7);
                z-index: 9999; border: 1px solid rgba(0, 255, 170, 0.12);
                user-select: none;
            }
            #flapper-panel .drag-handle {
                cursor: grab; padding: 4px 0 10px; margin: -6px -4px 4px -4px;
                border-radius: 12px 12px 0 0; display: flex; align-items: center;
                justify-content: space-between; user-select: none;
                border-bottom: 1px solid rgba(0, 255, 170, 0.08);
            }
            #flapper-panel .drag-handle:active { cursor: grabbing; }
            #flapper-panel .header {
                font-weight: 900; font-size: 16px;
                background: linear-gradient(135deg, #00ffaa, #00cc88);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                background-clip: text; display: flex; align-items: center; gap: 6px;
            }
            #flapper-panel .badge {
                background: rgba(0,255,170,0.12); -webkit-text-fill-color: #8b949e;
                font-size: 9px; padding: 2px 8px; border-radius: 20px;
                border: 1px solid rgba(0,255,170,0.15); font-weight: 700;
            }
            #flapper-panel .minimize-btn {
                background: rgba(255,255,255,0.06); border: 1px solid rgba(0,255,170,0.15);
                border-radius: 6px; width: 22px; height: 22px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                color: #8b949e; font-size: 12px; transition: all 0.15s;
            }
            #flapper-panel .minimize-btn:hover { background: rgba(0,255,170,0.15); color: #00ffaa; }
            #flapper-panel.minimized { width: auto; min-width: 160px; max-height: none; }
            #flapper-panel.minimized #fp-panel-body { display: none; }
            #flapper-panel label {
                display: block; margin: 8px 0 3px; color: #8b949e;
                font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
            }
            #flapper-panel select {
                width: 100%; padding: 5px 8px; background: rgba(255,255,255,0.04);
                border: 1px solid rgba(0,255,170,0.15); border-radius: 8px;
                color: #e6edf3; font-size: 12px; outline: none; cursor: pointer;
            }
            #flapper-panel select:focus { border-color: #00ffaa; }
            #flapper-panel .input-group { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
            #flapper-panel .input-group input[type="number"] {
                width: 50px; padding: 5px 6px; background: rgba(255,255,255,0.04);
                border: 1px solid rgba(0,255,170,0.15); border-radius: 6px;
                color: #e6edf3; font-size: 13px; font-weight: 700; outline: none;
                text-align: center; -moz-appearance: textfield;
            }
            #flapper-panel .input-group input[type="number"]:focus { border-color: #00ffaa; }
            #flapper-panel .input-group input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; }
            #flapper-panel .input-group input[type="range"] {
                flex: 1; accent-color: #00ffaa; height: 4px;
            }
            #flapper-panel .input-group span {
                min-width: 24px; text-align: center; font-weight: 700;
                color: #00ffaa; font-size: 13px;
            }
            #flapper-panel .checkbox-row {
                display: flex; align-items: center; gap: 8px; margin: 5px 0;
                padding: 3px 5px; background: rgba(255,255,255,0.02); border-radius: 6px;
            }
            #flapper-panel .checkbox-row input { accent-color: #00ffaa; width: 14px; height: 14px; cursor: pointer; }
            #flapper-panel .checkbox-row label {
                margin: 0; font-weight: 500; text-transform: none; letter-spacing: 0;
                font-size: 11px; color: #b1bac4; cursor: pointer;
            }
            #flapper-panel .btn-group { display: flex; gap: 5px; margin: 10px 0 8px; }
            #flapper-panel .btn {
                flex: 1; padding: 6px 0; border: none; border-radius: 8px;
                font-weight: 700; font-size: 10px; cursor: pointer; transition: all 0.15s;
                color: #c9d1d9; border: 1px solid rgba(255,255,255,0.04);
            }
            #flapper-panel .btn:hover { transform: scale(1.03); filter: brightness(1.2); }
            #flapper-panel .btn:active { transform: scale(0.97); }
            #flapper-panel .btn-start { background: linear-gradient(135deg, #00cc88, #00ffaa); color: #0a0e12; }
            #flapper-panel .btn-stop { background: linear-gradient(135deg, #cc2233, #ff4455); color: #fff; }
            #flapper-panel .btn-force { background: linear-gradient(135deg, #d29922, #ffcc44); color: #0a0e12; }
            #flapper-panel .btn-crash { background: linear-gradient(135deg, #8b0000, #cc2233); color: #fff; }
            #flapper-panel .custom-slider-row {
                display: flex; align-items: center; gap: 6px; margin: 3px 0;
            }
            #flapper-panel .custom-slider-row label {
                flex: 1; font-size: 10px; text-transform: none; margin: 0;
                color: #8b949e; font-weight: 600;
            }
            #flapper-panel .custom-slider-row input[type="range"] { flex: 2; accent-color: #00ffaa; }
            #flapper-panel .custom-slider-row span {
                min-width: 28px; text-align: right; font-weight: 700;
                color: #00ffaa; font-size: 11px;
            }
            #flapper-panel .log-box {
                background: rgba(0,0,0,0.4); border-radius: 8px; padding: 6px 8px;
                height: 80px; overflow-y: auto;
                font-family: 'JetBrains Mono', 'Fira Code', monospace;
                font-size: 10px; line-height: 1.5;
                border: 1px solid rgba(0,255,170,0.06); margin-top: 4px;
                color: #8b949e; scrollbar-width: thin;
            }
            #flapper-panel .log-box::-webkit-scrollbar { width: 3px; }
            #flapper-panel .log-box::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
            #flapper-panel .stats-box {
                background: rgba(0,255,170,0.04); border-radius: 8px; padding: 6px 8px;
                border: 1px solid rgba(0,255,170,0.08);
            }
            #flapper-panel .stats-box .stat-row {
                display: flex; justify-content: space-between; font-size: 10px;
                padding: 1px 0; color: #8b949e;
            }
            #flapper-panel .stats-box .stat-row .stat-val { color: #00ffaa; font-weight: 700; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'flapper-panel';
        panel.innerHTML = `
            <div class="drag-handle" id="fp-drag-handle">
                <div class="header">FLAPMASTER <span class="badge">v5.5</span></div>
                <div style="display:flex;gap:4px;align-items:center;">
                    <button class="minimize-btn" id="fp-minimize" title="Minimize">-</button>
                    <span style="color:#4ade80;font-size:12px;opacity:0.5;">⠿</span>
                </div>
            </div>
            <div id="fp-panel-body">
                <div class="stats-box">
                    <div class="stat-row"><span>Rounds</span><span class="stat-val" id="fp-stat-rounds">0</span></div>
                    <div class="stat-row"><span>Won</span><span class="stat-val" id="fp-stat-won">0</span></div>
                    <div class="stat-row"><span>Best</span><span class="stat-val" id="fp-stat-best">0</span></div>
                    <div class="stat-row"><span>Cashouts</span><span class="stat-val" id="fp-stat-cashouts">0</span></div>
                </div>

                <label>Bot Preset</label>
                <select id="fp-preset">
                    <option value="PERFECT_BOT">Perfect Bot</option>
                    <option value="HUMAN_PRO">Human Pro</option>
                    <option value="CASUAL_PLAYER" selected>Casual Player</option>
                    <option value="DRUNK_MODE">Drunk Mode</option>
                    <option value="CHAOS">Chaos</option>
                    <option value="CUSTOM">Custom</option>
                </select>

                <div id="custom-controls" style="display:none; margin-top:6px; background:rgba(255,255,255,0.02); border-radius:8px; padding:6px 8px; border:1px solid rgba(0,255,170,0.06);">
                    <div class="custom-slider-row">
                        <label>Accuracy %</label>
                        <input type="range" id="fp-custom-accuracy" min="0" max="100" value="65">
                        <span id="fp-custom-accuracy-val">65</span>
                    </div>
                    <div class="custom-slider-row">
                        <label>Miss %</label>
                        <input type="range" id="fp-custom-miss" min="0" max="100" value="15">
                        <span id="fp-custom-miss-val">15</span>
                    </div>
                    <div class="custom-slider-row">
                        <label>Delay (ms)</label>
                        <input type="range" id="fp-custom-delay" min="0" max="300" value="60">
                        <span id="fp-custom-delay-val">60</span>
                    </div>
                    <div class="custom-slider-row">
                        <label>Interval (ms)</label>
                        <input type="range" id="fp-custom-interval" min="50" max="300" value="70">
                        <span id="fp-custom-interval-val">70</span>
                    </div>
                </div>

                <label>Cash Out At</label>
                <div class="input-group">
                    <input type="number" id="fp-target-num" value="3" min="3" max="50">
                    <input type="range" id="fp-target-range" min="3" max="50" value="3">
                    <span id="fp-target-val">3</span>
                </div>

                <div class="checkbox-row"><input type="checkbox" id="fp-debug"><label>Debug mode</label></div>

                <div class="btn-group">
                    <button class="btn btn-start" id="fp-start">START</button>
                    <button class="btn btn-stop" id="fp-stop">STOP</button>
                    <button class="btn btn-force" id="fp-force">Force</button>
                    <button class="btn btn-crash" id="fp-crash">Crash</button>
                </div>

                <label>Log</label>
                <div class="log-box" id="fp-log"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // Drag
        const dragHandle = document.getElementById('fp-drag-handle');
        let isDragging = false, offsetX, offsetY;
        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            panel.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            let x = e.clientX - offsetX, y = e.clientY - offsetY;
            x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x));
            y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; panel.style.cursor = 'default'; });

        // Minimize
        document.getElementById('fp-minimize').addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('minimized');
            const btn = document.getElementById('fp-minimize');
            btn.textContent = panel.classList.contains('minimized') ? '+' : '-';
            btn.title = panel.classList.contains('minimized') ? 'Expand' : 'Minimize';
        });

        // Target sync
        const targetNum = document.getElementById('fp-target-num');
        const targetRange = document.getElementById('fp-target-range');
        const targetVal = document.getElementById('fp-target-val');
        targetNum.addEventListener('input', () => {
            let val = parseInt(targetNum.value) || 3;
            val = Math.min(50, Math.max(3, val));
            targetRange.value = val; targetVal.textContent = val; CONFIG.targetPipes = val;
        });
        targetRange.addEventListener('input', () => {
            const val = parseInt(targetRange.value);
            targetNum.value = val; targetVal.textContent = val; CONFIG.targetPipes = val;
        });

        // Preset
        const presetSelect = document.getElementById('fp-preset');
        const customControls = document.getElementById('custom-controls');
        presetSelect.addEventListener('change', function() {
            CONFIG.preset = this.value;
            customControls.style.display = this.value === 'CUSTOM' ? 'block' : 'none';
            if (this.value === 'CUSTOM') updateCustomConfig();
        });

        function updateCustomConfig() {
            CONFIG.customAccuracy = parseInt(document.getElementById('fp-custom-accuracy').value) / 100;
            CONFIG.customMissChance = parseInt(document.getElementById('fp-custom-miss').value) / 100;
            CONFIG.customDelayVariance = parseInt(document.getElementById('fp-custom-delay').value);
            CONFIG.customMinInterval = parseInt(document.getElementById('fp-custom-interval').value);
            document.getElementById('fp-custom-accuracy-val').textContent = document.getElementById('fp-custom-accuracy').value;
            document.getElementById('fp-custom-miss-val').textContent = document.getElementById('fp-custom-miss').value;
            document.getElementById('fp-custom-delay-val').textContent = document.getElementById('fp-custom-delay').value;
            document.getElementById('fp-custom-interval-val').textContent = document.getElementById('fp-custom-interval').value;
        }
        document.getElementById('fp-custom-accuracy').addEventListener('input', updateCustomConfig);
        document.getElementById('fp-custom-miss').addEventListener('input', updateCustomConfig);
        document.getElementById('fp-custom-delay').addEventListener('input', updateCustomConfig);
        document.getElementById('fp-custom-interval').addEventListener('input', updateCustomConfig);

        // Debug checkbox
        document.getElementById('fp-debug').addEventListener('change', function() {
            CONFIG.debugMode = this.checked;
            log(CONFIG.debugMode ? 'Debug ON.' : 'Debug OFF.');
        });

        // Buttons
        document.getElementById('fp-start').addEventListener('click', () => {
            if (!state.running) {
                state.running = true;
                log('Bot ready. Place a bet and start the round.');
                gameLoop();
            }
        });
        document.getElementById('fp-stop').addEventListener('click', () => {
            state.running = false; state.roundActive = false;
            log('Bot stopped.');
        });
        document.getElementById('fp-force').addEventListener('click', () => {
            state.roundActive = true; state.birdHistory = []; state.crashRequested = false;
            log('Force-started.');
        });
        document.getElementById('fp-crash').addEventListener('click', () => {
            if (state.roundActive) {
                state.crashRequested = true;
                log('Crash requested.');
                setTimeout(() => { state.crashRequested = false; log('Crash reset.'); }, 2000);
            } else {
                log('No active round.');
            }
        });
    }

    function updateStatsDisplay() {
        const el = (id) => document.getElementById(id);
        if (el('fp-stat-rounds')) el('fp-stat-rounds').textContent = stats.roundsPlayed;
        if (el('fp-stat-won')) el('fp-stat-won').textContent = stats.roundsWon;
        if (el('fp-stat-best')) el('fp-stat-best').textContent = stats.bestScore;
        if (el('fp-stat-cashouts')) el('fp-stat-cashouts').textContent = stats.cashouts;
    }

    // ==================== FORCE PANEL ====================
    function forceShowPanel() {
        if (document.getElementById('flapper-panel')) {
            document.getElementById('flapper-panel').style.display = 'block';
            return;
        }
        createPanel();
    }
    window.Flapper.showPanel = forceShowPanel;
    window.Flapper.getConfig = () => CONFIG;

    // ==================== INIT ====================
    function init() {
        log('FlapMaster v5.5 initializing...');
        canvas = findCanvas();
        if (canvas) {
            ctx = canvas.getContext('2d', { willReadFrequently: true });
            log(`Canvas: ${canvas.width}x${canvas.height}`);
        } else {
            log('Canvas not found - retrying...');
            setTimeout(() => {
                canvas = findCanvas();
                if (canvas) ctx = canvas.getContext('2d', { willReadFrequently: true });
            }, 2000);
        }
        createPanel();
        log('Loaded. If panel missing, type FlapMaster.showPanel() in console.');
    }

    window.addEventListener('load', () => setTimeout(init, 1000));
    if (document.readyState === 'complete') setTimeout(init, 1000);
})();
