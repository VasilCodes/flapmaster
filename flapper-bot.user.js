// ==UserScript==
// @name         FlapMaster – Auto-Flap Bot (GreenPump)
// @namespace    http://tampermonkey.net/
// @version      6.2
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
    // The same planner used in test_simulation.html.
    //
    // Old algorithm aimed at "40% from top of safe zone" which was fatally
    // wrong: one flap rises jumpForce²/(2*gravity) ≈ 66px, the band is
    // only 88px, and flapping at 40% from top always punches through the
    // ceiling. The fix: a short-horizon planner that simulates "flap now"
    // vs "coast now" and picks whichever survives longer.
    const PLAN_HORIZON = 200;
    const BAND_MARGIN  = 4;

    function riseHeight(d) {
        return (d.jumpForce * d.jumpForce) / (2 * d.gravity);
    }

    // Cheap fallback policy: oscillation centred on the gap centre.
    function heurFlap(birdY, birdVY, pipesAhead, d) {
        // Ground emergency — always flap
        if (birdY > GROUND_Y - BIRD_RADIUS - 40) return true;

        // No pipes detected: be CONSERVATIVE. Only flap when falling
        // below the lower third of the play area. This avoids the
        // "spam upwards" problem where the bot flaps every frame
        // because the bird is above the screen centre.
        let pipe = null;
        for (const p of pipesAhead) {
            if (p.x > state.bird.x - 30) { pipe = p; break; }
        }
        if (!pipe) {
            const playHeight = GROUND_Y - 60; // approximate playable height
            return birdVY >= 0 && birdY > 60 + playHeight * 0.65;
        }

        const bandTop = (pipe.gapTop || pipe.topH) + BIRD_RADIUS + BAND_MARGIN;
        const bandBot = (pipe.gapBottom || pipe.botY) - BIRD_RADIUS - BAND_MARGIN;
        const gapCenter = ((pipe.gapTop || pipe.topH) + (pipe.gapBottom || pipe.botY)) / 2;
        let fp = gapCenter + riseHeight(d) * 0.5;
        if (fp > bandBot) fp = bandBot;
        if (fp < bandTop + 2) fp = bandTop + 2;
        return birdY > fp && birdVY >= 0;
    }

    // Simulate forward. First frame uses firstAction, then falls back to
    // heurFlap. Returns {frames survived, pipes passed}.
    function rolloutFlapAt(y, vy, pipesAhead, d, spd, firstAction, horizon) {
        let py = y, pvy = vy, passed = 0;
        const birdX = state.bird.x || 120;
        const px = pipesAhead.map(p => ({
            x: p.x,
            topH: p.gapTop || p.topH,
            botY: p.gapBottom || p.botY,
            passed: false
        }));
        for (let i = 0; i < horizon; i++) {
            const act = (i === 0) ? firstAction : heurFlap(py, pvy, px, d);
            if (act) pvy = d.jumpForce;
            pvy = Math.min(d.maxFallSpeed, pvy + d.gravity);
            py += pvy;
            if (py + BIRD_RADIUS >= GROUND_Y) return { frames: i, passed };
            if (py - BIRD_RADIUS <= 0) { py = BIRD_RADIUS; pvy = 0; }
            for (const p of px) p.x -= spd;
            for (const p of px) {
                if (birdX + BIRD_RADIUS > p.x && birdX - BIRD_RADIUS < p.x + PIPE_WIDTH &&
                    (py - BIRD_RADIUS < p.topH || py + BIRD_RADIUS > p.botY))
                    return { frames: i, passed };
            }
            for (const p of px) {
                if (!p.passed && birdX > p.x + PIPE_WIDTH) { p.passed = true; passed++; }
            }
        }
        return { frames: horizon, passed };
    }

    // The actual decision: try flap-now and coast-now, keep whichever
    // survives longer. This fixes the phase problem that a fixed threshold
    // can't solve — 66px rise in an 88px band demands proper planning.
    function botShouldFlap(birdY, birdVY, pipesAhead, d, spd) {
        const ahead = pipesAhead.filter(p => p.x > state.bird.x - 30);
        const f = rolloutFlapAt(birdY, birdVY, ahead, d, spd, true, PLAN_HORIZON);
        const c = rolloutFlapAt(birdY, birdVY, ahead, d, spd, false, PLAN_HORIZON);
        if (f.frames === PLAN_HORIZON && c.frames === PLAN_HORIZON) {
            return heurFlap(birdY, birdVY, ahead, d);
        }
        if (f.frames !== c.frames) return f.frames > c.frames;
        if (f.passed !== c.passed) return f.passed > c.passed;
        return heurFlap(birdY, birdVY, ahead, d);
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

        // Check for game over
        for (const sel of ['.game-over', '[class*="gameover"]', '[class*="crashed"]']) {
            const el = document.querySelector(sel);
            if (el && getComputedStyle(el).display !== 'none') return false;
        }

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

    // ==================== BIRD POSITION (Canvas) ====================
    // The bird is a pixel-art sprite (loaded from /flappy-bird.png) with
    // MULTIPLE shades of green (bright lime to dark green), a white eye,
    // and a black outline. The old detection only matched the very brightest
    // green (G>180) which was too strict — the cluster never reached the
    // 15px minimum, so detection always returned null.
    //
    // New approach: match ANY green-dominant pixel (G>R and G>100) in the
    // left half of the canvas. The bird is the only green object there
    // during gameplay (bushes/trees are far left/bottom and much larger).
    // Filter by cluster size: bird is ~500-2000px, bushes are 5000+.
    function readBirdSample() {
        if (!canvas || !ctx) return null;

        try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const w = canvas.width;
            const h = canvas.height;

            let clusters = [];
            let visited = new Uint8Array(w * h);

            // Scan the left half of the canvas, excluding ground and top sky.
            // Step by 2px for better cluster connectivity than the old 3px.
            for (let y = 40; y < h - 80; y += 2) {
                for (let x = 30; x < w * 0.5; x += 2) {
                    const idx = (y * w + x) * 4;
                    const r = data[idx], g = data[idx+1], b = data[idx+2];

                    // Bird-dominant green: any pixel where green channel
                    // dominates red AND is reasonably bright. This catches
                    // all shades of the sprite (bright highlights through
                    // medium body greens) while excluding sky (blue-heavy),
                    // pipes (darker/different hue), ground (brown), and the
                    // black outline.
                    if (g < 100 || g <= r || (g - r) < 20) continue;
                    if (visited[y * w + x]) continue;

                    // Flood-fill cluster — allow up to 3000px (bird sprite
                    // with surrounding green pixels). Bushes/trees are 5000+.
                    let pixels = [];
                    let stack = [[x, y]];
                    while (stack.length > 0 && pixels.length < 3000) {
                        const [cx, cy] = stack.pop();
                        if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
                        const ci = (cy * w + cx) * 4;
                        if (visited[cy * w + cx]) continue;
                        const cr = data[ci], cg = data[ci+1], cb = data[ci+2];
                        if (cg < 100 || cg <= cr || (cg - cr) < 20) continue;
                        visited[cy * w + cx] = 1;
                        pixels.push({ x: cx, y: cy });
                        stack.push([cx+2, cy], [cx-2, cy], [cx, cy+2], [cx, cy-2]);
                    }

                    // Bird cluster: 30-2500 pixels
                    // (bushes/trees are 5000+, pipes are vertical and far right)
                    if (pixels.length >= 30 && pixels.length <= 2500) {
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

            if (clusters.length === 0) return null;

            // Pick the cluster closest to the bird's last known Y (falls back
            // to canvas center on the very first sample). This is more stable
            // than "closest to center" once the bird has moved.
            const anchorY = state.bird.hasSample ? state.bird.y : h / 2;
            clusters.sort((a, b) => Math.abs(a.y - anchorY) - Math.abs(b.y - anchorY));
            const best = clusters[0];

            debugLog(`Bird sample: (${best.x.toFixed(0)}, ${best.y.toFixed(0)}) size=${best.size} [${clusters.length} clusters]`);
            return { x: best.x, y: best.y, size: best.size, clusterCount: clusters.length };
        } catch (e) {
            debugLog(`Canvas error: ${e.message}`);
            return null;
        }
    }

    // ==================== BIRD PHYSICS ====================
    // Treats the bird as a real object on the y-axis: a position + velocity
    // that gets integrated by gravity every frame, and corrected (not
    // replaced) by whatever the canvas scan sees. On a flap we set the
    // velocity to the known jump force immediately, instead of waiting for a
    // noisy pixel sample to "catch up" - this is what stops the bot from
    // repeatedly re-flapping while it's already rising (the bug that made
    // the bird just rocket to the ceiling and stay there).
    function updateBirdPhysics(sample, difficultyConfig) {
        const bird = state.bird;

        if (sample) {
            if (bird.hasSample) {
                // Raw per-frame velocity estimate from the movement of the
                // sample. Smoothed (EMA) so one noisy read can't cause a
                // spike that flips the flap decision for a whole frame.
                const rawVy = sample.y - bird.y;
                bird.vy = bird.vy * 0.5 + rawVy * 0.5;
            }
            // Blend toward the fresh reading rather than snapping straight to
            // it - keeps the tracked position smooth even if a single scan
            // is a few pixels off.
            bird.y = bird.hasSample ? (bird.y * 0.5 + sample.y * 0.5) : sample.y;
            bird.x = sample.x;
            bird.hasSample = true;
            debugLog(`Bird sample: (${sample.x.toFixed(0)}, ${sample.y.toFixed(0)}) -> y=${bird.y.toFixed(1)} vy=${bird.vy.toFixed(1)} [${sample.size}px, ${sample.clusterCount} clusters]`);
        } else if (bird.hasSample) {
            // No sample this frame - keep the bird "alive" as a real falling
            // object instead of freezing in place or guessing randomly.
            bird.vy = Math.min(bird.vy + difficultyConfig.gravity, difficultyConfig.maxFallSpeed);
            bird.y += bird.vy;
        }
    }

    // ==================== PIPE DETECTION (Canvas) ====================
    // REAL GAME pipe colors (from 41qzff47zxjhm.js source):
    //   #a3e048 (163,224,72) — brightest stripe
    //   #8cd600 (140,214,0)  — second stripe
    //   #73bf2e (115,191,46) — middle stripe
    //   #558b2f (85,139,47)  — darker stripe
    //   #3d661b (61,102,27)  — very dark stripe
    //   #2e5200 (46,82,0)    — outline/stroke
    // Sky: #4ec0ca → #8edde4 (cyan, R≈G high, B high)
    // Pipe = greenish (G >> R) and not cyan (B not too high relative to G).
    // Key insight: sky has G≈R (both ~200), pipes have G >> R.
    function readPipes() {
        if (!canvas || !ctx) return [];

        try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const w = canvas.width;
            const groundY = GROUND_Y;

            const birdX = state.bird.x || 120;
            const scanStart = Math.max(birdX - BIRD_RADIUS - 5, 30);

            // For each x, collect y-positions of pipe-colored pixels.
            let colData = [];
            for (let x = scanStart; x < w - 5; x += 3) {
                let pipeYs = [];
                for (let y = 30; y < groundY; y += 2) {
                    const idx = (y * w + x) * 4;
                    const r = data[idx], g = data[idx+1], b = data[idx+2];

                    // Bright pipe stripe: green dominates red by 30+
                    const isGreenish = g > r + 30 && g > 60 && r < 180;
                    // Dark outline: very dark and greenish
                    const isDarkGreen = r < 70 && g < 110 && g > r && (g + r + b) / 3 < 70;

                    if (isGreenish || isDarkGreen) {
                        pipeYs.push(y);
                    }
                }
                if (pipeYs.length > 0) colData.push({ x, pipeYs });
            }

            // Group nearby x-columns into pipe candidates (within 12px)
            let pipeCandidates = [];
            for (const col of colData) {
                const last = pipeCandidates[pipeCandidates.length - 1];
                if (last && col.x - last.xEnd < 12) {
                    last.xEnd = col.x;
                    last.cols.push(col);
                } else {
                    pipeCandidates.push({ xStart: col.x, xEnd: col.x, cols: [col] });
                }
            }

            // For each candidate, find the gap (largest continuous region
            // with NO pipe-colored pixels)
            let pipes = [];
            for (const cand of pipeCandidates) {
                if (cand.cols.length < 3) continue;

                let allPipeY = new Set();
                for (const col of cand.cols) {
                    for (const y of col.pipeYs) allPipeY.add(y);
                }
                let sorted = [...allPipeY].sort((a, b) => a - b);
                if (sorted.length < 8) continue;

                // Find gaps: continuous regions with no pipe pixels
                let gaps = [];
                let prevY = sorted[0];
                for (let i = 1; i < sorted.length; i++) {
                    if (sorted[i] - prevY > 20) {
                        if (sorted[i] - prevY >= 40) {
                            gaps.push({ top: prevY, bottom: sorted[i], size: sorted[i] - prevY });
                        }
                    }
                    prevY = sorted[i];
                }
                // Also check gap after last pipe pixel to ground
                if (groundY - sorted[sorted.length - 1] > 40) {
                    gaps.push({ top: sorted[sorted.length - 1], bottom: groundY, size: groundY - sorted[sorted.length - 1] });
                }
                // And gap before first pipe pixel from top
                if (sorted[0] - 30 > 40) {
                    gaps.push({ top: 30, bottom: sorted[0], size: sorted[0] - 30 });
                }

                if (gaps.length === 0) continue;
                gaps.sort((a, b) => b.size - a.size);
                const bestGap = gaps[0];

                pipes.push({
                    x: (cand.xStart + cand.xEnd) / 2,
                    gapCenter: (bestGap.top + bestGap.bottom) / 2,
                    gapTop: bestGap.top,
                    gapBottom: bestGap.bottom,
                    gapSize: bestGap.size
                });
            }

            pipes.sort((a, b) => a.x - b.x);
            pipes = pipes.filter(p => p.x > birdX - 20);

            if (state.debugMode) {
                debugLog(`Pipes: ${pipes.length} [${pipes.map(p => `x=${p.x.toFixed(0)} gap=${p.gapTop.toFixed(0)}-${p.gapBottom.toFixed(0)} (${p.gapSize.toFixed(0)}px)`).join(', ')}]`);
            }

            const now = Date.now();
            if (pipes.length > 0) {
                state.lastKnownPipes = pipes;
                state.lastPipeDetectTime = now;
            } else if (now - state.lastPipeDetectTime < PIPE_TARGET_GRACE_MS && state.lastKnownPipes.length > 0) {
                debugLog(`Using ${state.lastKnownPipes.length} cached pipes (grace)`);
                return state.lastKnownPipes;
            }

            return pipes.slice(0, LOOKAHEAD_PIPES);
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
    function gameLoop() {
        if (!state.running) {
            requestAnimationFrame(gameLoop);
            return;
        }

        const now = Date.now();
        const config = DIFFICULTY[CONFIG.difficulty || 'chill'];

        // Update the bird as a physics object every frame: sample the
        // canvas, then integrate/correct position+velocity from that.
        const birdSample = readBirdSample();
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

        // Detect up to LOOKAHEAD_PIPES pipes ahead of the bird.
        const pipesAhead = readPipes();

        const birdY = state.bird.y;
        const birdVY = state.bird.vy;
        debugLog(`birdY=${birdY.toFixed(0)} vy=${birdVY.toFixed(1)} pipes=${pipesAhead.length}`);

        // The planner decides every frame and is naturally self-limiting:
        // flapping sets vy negative, so "coast" wins the next rollout and
        // we don't flap again until actually falling.
        const spd = config.speed + Math.min(0.55, 0.028 * state.currentScore);
        const shouldFlap = botShouldFlap(birdY, birdVY, pipesAhead, config, spd);

        if (shouldFlap) {
            if (Math.random() < missChance) {
                debugLog('Miss chance - skip flap');
            } else {
                simulateKey(' ');
                state.bird.vy = config.jumpForce;
                state.lastFlapTime = now;
            }
        }

        // Debug overlay: draw detected pipes on the canvas
        if (CONFIG.debugMode && canvas && ctx) {
            const pipes = state.lastKnownPipes || [];
            for (const p of pipes) {
                // Draw gap center line
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(p.x, p.gapTop);
                ctx.lineTo(p.x + PIPE_WIDTH, p.gapTop);
                ctx.moveTo(p.x, p.gapBottom);
                ctx.lineTo(p.x + PIPE_WIDTH, p.gapBottom);
                ctx.stroke();
                // Draw gap center dot
                ctx.fillStyle = '#00ff88';
                ctx.beginPath();
                ctx.arc(p.x + PIPE_WIDTH / 2, p.gapCenter, 4, 0, Math.PI * 2);
                ctx.fill();
                // Label
                ctx.fillStyle = '#00ff88';
                ctx.font = '11px monospace';
                ctx.fillText(`gap:${p.gapSize.toFixed(0)}px`, p.x + PIPE_WIDTH + 4, p.gapCenter);
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
                <div class="header">FLAPMASTER <span class="badge">v6.2</span></div>
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
        log('FlapMaster v6.2 initializing...');
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
