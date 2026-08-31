// ==UserScript==
// @name         FlapMaster – Auto-Flap Bot (GreenPump)
// @namespace    http://tampermonkey.net/
// @version      7.2
// @description  Auto-flap bot. Detects bird position via canvas, flaps and cashes out with keyboard simulation.
// @author       zavko & limerence
// @match        https://greenpump.xyz/flappy*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Inject willReadFrequently BEFORE any page script calls getContext.
    const _origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        if (type === '2d') {
            attrs = Object.assign({}, attrs || {}, { willReadFrequently: true });
        }
        return _origGetContext.call(this, type, attrs);
    };

    window.Flapper = { showPanel: null, getConfig: null, name: 'FlapMaster' };

    // ==================== CONFIGURATION ====================
    const CONFIG = {
        targetPipes: 3,
        preset: 'CASUAL_PLAYER',
        customAccuracy: 0.65,
        customMissChance: 0.15,
        customDelayVariance: 60,
        debugMode: false,
    };

    // Game physics (EXACT from source: 41qzff47zxjhm.js)
    // Bot behavior profiles. No minInterval/click-limit here on purpose -
    // the flap decision is physics-based and self-limiting (see gameLoop).
    const PROFILES = {
        PERFECT_BOT:   { flapAccuracy: 0.98, missChance: 0.01, delayVariance: 5   },
        HUMAN_PRO:     { flapAccuracy: 0.85, missChance: 0.05, delayVariance: 25  },
        CASUAL_PLAYER: { flapAccuracy: 0.65, missChance: 0.15, delayVariance: 60  },
        DRUNK_MODE:    { flapAccuracy: 0.40, missChance: 0.35, delayVariance: 150 },
        CHAOS:         { flapAccuracy: 0.10, missChance: 0.60, delayVariance: 300 },
        CUSTOM:        { flapAccuracy: 0.65, missChance: 0.15, delayVariance: 60  }
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

    // How many upcoming pipes we try to keep detected/tracked at once.
    // Only the nearest one is used to aim, but keeping 3 means the bot
    // doesn't lose the target the instant one canvas scan misses.
    const LOOKAHEAD_PIPES = 3;
    // If we briefly lose pipe detection, keep steering at the last known
    // gap for this long (ms) before giving up and centering.
    const PIPE_TARGET_GRACE_MS = 800;

    // ==================== BOT CORE ====================
    // Dead-simple approach based on how working Flappy Bird bots work:
    // 1. Scan ONE row near y=0 for non-sky pixels = pipe columns
    // 2. Scan DOWN each pipe column to find where pipe stops = gap
    // 3. If bird is below gap center → flap
    // That's it. No planner, no heuristics. Just detection + simple rule.

    function riseHeight(d) {
        return (d.jumpForce * d.jumpForce) / (2 * d.gravity);
    }

    // Sky detection: the sky is CYAN — both green AND blue are high and
    // close to each other. Real values: #4ec0ca (78,204,202) to
    // #8edde4 (142,221,228). Key: b > 140 and |g-b| < 60.
    function isSky(r, g, b) {
        if (b < 140) return false;
        if (g < 100) return false;
        if (Math.abs(g - b) > 60) return false;
        return true;
    }

    // Pipe detection: pipes are GREEN — green dominates both red AND blue.
    // Real values: #a3e048 (163,224,72), #8cd600 (140,214,0),
    // #558b2f (85,139,47), #3d661b (61,102,27).
    // Key: g > r + 20 AND g > b + 30. Blue is always LOW on pipes.
    function isPipe(r, g, b) {
        if (g <= r + 20) return false;
        if (g <= b + 30) return false;
        if (g < 40) return false;
        return true;
    }

    // Scan ONE horizontal line near the top of the canvas for pipe columns.
    // Returns array of x positions where pipes exist.
    function findPipeXPositions(imageData, w) {
        const data = imageData.data;
        const scanY = 5; // near top edge
        let pipeXs = [];
        let inPipe = false;
        let pipeStart = 0;

        for (let x = 0; x < w - 5; x++) {
            const idx = (scanY * w + x) * 4;
            const r = data[idx], g = data[idx+1], b = data[idx+2];
            const pipe = isPipe(r, g, b) && !isSky(r, g, b);

            if (pipe && !inPipe) {
                pipeStart = x;
                inPipe = true;
            } else if (!pipe && inPipe) {
                // End of pipe region - use the center x
                const centerX = (pipeStart + x) / 2;
                if (x - pipeStart > 10) { // pipe must be at least 10px wide
                    pipeXs.push(centerX);
                }
                inPipe = false;
            }
        }
        if (inPipe) {
            const centerX = (pipeStart + w - 5) / 2;
            if (w - 5 - pipeStart > 10) pipeXs.push(centerX);
        }
        return pipeXs;
    }

    // Given a pipe's x position, scan DOWN to find the gap.
    // Returns { gapTop, gapBottom } or null.
    function findPipeGap(imageData, w, pipeX, groundY) {
        const data = imageData.data;
        // Scan a few columns around pipeX and merge results
        let allPipeY = new Set();

        for (let dx = -5; dx <= 5; dx += 2) {
            const x = Math.round(pipeX + dx);
            if (x < 0 || x >= w) continue;

            for (let y = 0; y < groundY; y++) {
                const idx = (y * w + x) * 4;
                const r = data[idx], g = data[idx+1], b = data[idx+2];
                if (isPipe(r, g, b)) {
                    allPipeY.add(y);
                }
            }
        }

        if (allPipeY.size < 10) return null;

        let sorted = [...allPipeY].sort((a, b) => a - b);

        // Find the largest gap (continuous region with no pipe pixels)
        let bestGapTop = 0, bestGapBot = groundY, bestGapSize = 0;
        let gapStart = sorted[0];

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] - sorted[i-1] > 15) {
                // Gap between sorted[i-1] and sorted[i]
                const gapTop = sorted[i-1];
                const gapBot = sorted[i];
                const gapSize = gapBot - gapTop;
                if (gapSize > bestGapSize) {
                    bestGapSize = gapSize;
                    bestGapTop = gapTop;
                    bestGapBot = gapBot;
                }
            }
        }

        if (bestGapSize < 40) return null; // real gaps are 91-114px

        return { gapTop: bestGapTop, gapBottom: bestGapBot, gapCenter: (bestGapTop + bestGapBot) / 2 };
    }

    // Detect the bird by scanning a narrow strip around x=90-150 for
    // non-sky, non-pipe pixels (the bird sprite).
    // Uses shared imageData from gameLoop to avoid repeated getImageData calls.
    function readBirdSample(imageData, w) {
        if (!canvas || !ctx || !imageData) return null;
        try {
            const scanX = 90, scanW = 60;
            const data = imageData.data;
            let birdPixels = [];

            for (let x = 0; x < scanW; x++) {
                for (let y = 50; y < GROUND_Y; y += 2) {
                    const idx = (y * w + (scanX + x)) * 4;
                    const r = data[idx], g = data[idx+1], b = data[idx+2];
                    if (!isSky(r, g, b) && !isPipe(r, g, b)) {
                        birdPixels.push({ x: scanX + x, y });
                    }
                }
            }

            if (birdPixels.length < 5 || birdPixels.length > 2000) return null;

            let sumX = 0, sumY = 0;
            for (const p of birdPixels) { sumX += p.x; sumY += p.y; }
            return { x: sumX / birdPixels.length, y: sumY / birdPixels.length, size: birdPixels.length };
        } catch (e) {
            return null;
        }
    }

    // The flap decision: if bird is below the gap center, flap.
    function botShouldFlap(birdY, birdVY, pipesAhead, d) {
        if (birdY > GROUND_Y - BIRD_RADIUS - 40) return true; // ground emergency

        let pipe = null;
        for (const p of pipesAhead) {
            if (p.x > (state.bird.x || 120) - BIRD_RADIUS) { pipe = p; break; }
        }
        if (!pipe) {
            // No pipe visible — maintain altitude: flap when falling below mid-screen
            return birdVY >= 0 && birdY > GROUND_Y * 0.55;
        }

        // Flap when bird is below the gap center (with small offset)
        // The rise per flap is ~66px, gap is ~100px, so this creates
        // a gentle oscillation through the gap.
        const target = pipe.gapCenter - 5; // aim slightly above center
        return birdY > target && birdVY >= 0;
    }

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
        // The bird is tracked as a simple physics object: a position (y) and
        // a velocity (vy), just like the real game simulates it. Canvas
        // scanning only gives us a noisy *sample* of where the bird is; we
        // integrate gravity/flap impulses on top of that sample instead of
        // re-deriving velocity from noisy timestamp math every frame.
        bird: { x: CANVAS_W * 0.13, y: CANVAS_H / 2, vy: 0, hasSample: false },
        lastFlapTime: 0,
        cashoutPending: false,
        birdHistory: [],
        detectionFrames: 0,
        crashRequested: false,
        overlayDetected: false,
        roundStartLogged: false,
        lastKnownPipes: [],    // grace: keep last detected pipes briefly
        lastPipeDetectTime: 0,
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
                delayVariance: CONFIG.customDelayVariance
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
    // Two modes:
    // 1. Not yet in a round: accumulate bird history, detect movement
    // 2. Already in a round: just check for game over, keep going
    function isRoundActive(hasSample) {
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

        // Check for game over elements
        for (const sel of ['.game-over', '[class*="gameover"]', '[class*="crashed"]']) {
            const el = document.querySelector(sel);
            if (el && getComputedStyle(el).display !== 'none') return false;
        }

        // ALREADY IN A ROUND: keep going as long as we have a bird sample.
        // Don't require history — the round was already confirmed.
        if (state.roundActive) {
            if (!hasSample) {
                state.detectionFrames++;
                if (state.detectionFrames > 30) return false; // lost bird for 30 frames → round over
            } else {
                state.detectionFrames = 0;
            }
            return true;
        }

        // NOT YET IN A ROUND: need bird sample + movement to confirm.
        if (!hasSample) {
            state.detectionFrames++;
            if (state.detectionFrames > 60) return false;
            return false;
        }
        state.detectionFrames = 0;

        // Track bird movement to detect active round
        state.birdHistory.push(state.bird.y);
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

    // ==================== BIRD PHYSICS ====================
    function updateBirdPhysics(sample, difficultyConfig) {
        const bird = state.bird;

        if (sample) {
            if (bird.hasSample) {
                bird.vy = bird.vy * 0.5 + (sample.y - bird.y) * 0.5;
            }
            bird.y = bird.hasSample ? (bird.y * 0.6 + sample.y * 0.4) : sample.y;
            bird.x = sample.x;
            bird.hasSample = true;
        } else if (bird.hasSample) {
            bird.vy = Math.min(bird.vy + difficultyConfig.gravity, difficultyConfig.maxFallSpeed);
            bird.y += bird.vy;
        }
    }

    // ==================== PIPE DETECTION ====================
    // Simple approach: scan top row for pipe columns, then scan down for gaps.
    // Uses shared imageData from gameLoop to avoid repeated getImageData calls.
    function readPipes(imageData, w) {
        if (!canvas || !ctx || !imageData) return [];
        try {

            // Step 1: find pipe x-positions by scanning y=5
            const pipeXs = findPipeXPositions(imageData, w);
            if (pipeXs.length === 0) {
                // Grace period
                const now = Date.now();
                if (now - state.lastPipeDetectTime < PIPE_TARGET_GRACE_MS && state.lastKnownPipes.length > 0) {
                    return state.lastKnownPipes;
                }
                return [];
            }

            // Step 2: for each pipe x, find the gap
            let pipes = [];
            const birdX = state.bird.x || 120;
            for (const pipeX of pipeXs) {
                if (pipeX < birdX - 20) continue; // behind the bird
                const gap = findPipeGap(imageData, w, pipeX, GROUND_Y);
                if (gap) {
                    pipes.push({
                        x: pipeX,
                        gapTop: gap.gapTop,
                        gapBottom: gap.gapBottom,
                        gapCenter: gap.gapCenter,
                        gapSize: gap.gapBottom - gap.gapTop
                    });
                }
            }

            pipes.sort((a, b) => a.x - b.x);

            if (pipes.length > 0) {
                state.lastKnownPipes = pipes;
                state.lastPipeDetectTime = Date.now();
            }

            return pipes;
        } catch (e) {
            debugLog(`Pipe detection error: ${e.message}`);
            return state.lastKnownPipes.length > 0 &&
                   Date.now() - state.lastPipeDetectTime < PIPE_TARGET_GRACE_MS
                ? state.lastKnownPipes : [];
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
    let _colorDumpDone = false;
    function gameLoop() {
        if (!state.running) {
            requestAnimationFrame(gameLoop);
            return;
        }

        const now = Date.now();
        const config = DIFFICULTY[CONFIG.difficulty || 'chill'];

        // Read canvas ONCE per frame — both bird and pipe detection share it.
        let imageData = null;
        if (canvas && ctx) {
            try {
                imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            } catch (e) { /* ignore */ }
        }
        const w = canvas ? canvas.width : 940;

        // One-shot color diagnostic: dump actual pixel values at key positions
        if (imageData && !_colorDumpDone) {
            _colorDumpDone = true;
            const data = imageData.data;
            log('=== COLOR DIAGNOSTIC ===');
            // Sample y=5 (pipe scan line) at several x positions
            for (const sx of [0, 50, 120, 200, 300, 400, 500, 600, 700, 800, 900]) {
                const idx = (5 * w + sx) * 4;
                const r = data[idx], g = data[idx+1], b = data[idx+2];
                const sky = isSky(r, g, b);
                const pipe = isPipe(r, g, b);
                console.log(`[FM-DIAG] y=5 x=${sx}: rgb(${r},${g},${b}) sky=${sky} pipe=${pipe}`);
            }
            // Sample y=200 (mid-screen)
            for (const sx of [0, 50, 120, 200, 300, 400, 500, 600, 700, 800, 900]) {
                const idx = (200 * w + sx) * 4;
                const r = data[idx], g = data[idx+1], b = data[idx+2];
                const sky = isSky(r, g, b);
                const pipe = isPipe(r, g, b);
                console.log(`[FM-DIAG] y=200 x=${sx}: rgb(${r},${g},${b}) sky=${sky} pipe=${pipe}`);
            }
            // Sample bird area x=100-140, y=100-400
            for (const sy of [100, 150, 200, 250, 300, 350, 400]) {
                const idx = (sy * w + 120) * 4;
                const r = data[idx], g = data[idx+1], b = data[idx+2];
                const sky = isSky(r, g, b);
                const pipe = isPipe(r, g, b);
                console.log(`[FM-DIAG] y=${sy} x=120: rgb(${r},${g},${b}) sky=${sky} pipe=${pipe}`);
            }
            log('Color diagnostic printed to console (F12)');
        }

        const birdSample = readBirdSample(imageData, w);
        updateBirdPhysics(birdSample, config);

        const active = isRoundActive(!!birdSample);
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
            state.bird.vy = config.jumpForce;
            state.lastFlapTime = now;
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
        const { missChance } = profile;

        const pipesAhead = readPipes(imageData, w);

        const birdY = state.bird.y;
        const birdVY = state.bird.vy;

        // SAFETY: if bird is in the top 25% AND rising, never flap.
        const tooHigh = birdY < (GROUND_Y * 0.25) && birdVY < 0;
        // SAFETY: ground emergency
        const tooLow = birdY > (GROUND_Y - BIRD_RADIUS - 40);

        // Log status — debug mode logs every frame, otherwise every 60 frames
        const pipeInfo = pipesAhead.length > 0
            ? pipesAhead.map(p => `x=${p.x.toFixed(0)} gap=${p.gapTop.toFixed(0)}-${p.gapBottom.toFixed(0)}`).join('; ')
            : 'NONE';
        state._frameCount = (state._frameCount || 0) + 1;
        if (CONFIG.debugMode || state._frameCount % 60 === 0) {
            console.log(`[FM] y=${birdY.toFixed(0)} vy=${birdVY.toFixed(1)} pipes=[${pipeInfo}] score=${state.currentScore} birdSample=${!!birdSample}`);
        }

        let shouldFlap = false;
        if (tooLow) {
            // Ground emergency - always flap, bypass cooldown
            shouldFlap = true;
        } else if (!tooHigh) {
            shouldFlap = botShouldFlap(birdY, birdVY, pipesAhead, config);
        }

        const MIN_FLAP_INTERVAL = 150;

        if (shouldFlap) {
            if (Math.random() < missChance) {
                debugLog('Miss chance - skip flap');
            } else if (now - state.lastFlapTime >= MIN_FLAP_INTERVAL) {
                simulateKey(' ');
                state.bird.vy = config.jumpForce;
                state.lastFlapTime = now;
                console.log(`[FM] FLAP!`);
            }
        }

        // Debug overlay: draw detected pipes on the canvas
        if (CONFIG.debugMode && canvas && ctx) {
            const pipes = state.lastKnownPipes || [];
            for (const p of pipes) {
                const leftX = p.x - PIPE_WIDTH / 2;
                // Draw gap center line
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(leftX, p.gapTop);
                ctx.lineTo(leftX + PIPE_WIDTH, p.gapTop);
                ctx.moveTo(leftX, p.gapBottom);
                ctx.lineTo(leftX + PIPE_WIDTH, p.gapBottom);
                ctx.stroke();
                // Draw gap center dot
                ctx.fillStyle = '#00ff88';
                ctx.beginPath();
                ctx.arc(p.x, p.gapCenter, 4, 0, Math.PI * 2);
                ctx.fill();
                // Label
                ctx.fillStyle = '#00ff88';
                ctx.font = '11px monospace';
                ctx.fillText(`gap:${p.gapSize.toFixed(0)}px`, leftX + PIPE_WIDTH + 4, p.gapCenter);
            }
            // Draw bird target
            ctx.fillStyle = 'rgba(0,255,136,0.3)';
            ctx.fillRect(0, state.bird.y - 1, CANVAS_W, 2);
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
                <div class="header">FLAPMASTER <span class="badge">v6.5</span></div>
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
            document.getElementById('fp-custom-accuracy-val').textContent = document.getElementById('fp-custom-accuracy').value;
            document.getElementById('fp-custom-miss-val').textContent = document.getElementById('fp-custom-miss').value;
            document.getElementById('fp-custom-delay-val').textContent = document.getElementById('fp-custom-delay').value;
        }
        document.getElementById('fp-custom-accuracy').addEventListener('input', updateCustomConfig);
        document.getElementById('fp-custom-miss').addEventListener('input', updateCustomConfig);
        document.getElementById('fp-custom-delay').addEventListener('input', updateCustomConfig);

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
        log('FlapMaster v7.2 initializing...');
        canvas = findCanvas();
        if (canvas) {
            ctx = canvas.getContext('2d');
            log(`Canvas: ${canvas.width}x${canvas.height}`);
        } else {
            log('Canvas not found - retrying...');
            setTimeout(() => {
                canvas = findCanvas();
                if (canvas) ctx = canvas.getContext('2d');
            }, 2000);
        }
        createPanel();
        log('Loaded. If panel missing, type FlapMaster.showPanel() in console.');
    }

    window.addEventListener('load', () => setTimeout(init, 1000));
    if (document.readyState === 'complete') setTimeout(init, 1000);
})();
