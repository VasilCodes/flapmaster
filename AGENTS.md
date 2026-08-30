# AGENTS.md — FlapMaster Project Handoff

> **Project:** FlapMaster — Tampermonkey auto-flap bot for GreenPump Flappy Bird
> **Repo:** https://github.com/VasilCodes/flapmaster
> **Authors:** zavko & limerence
> **Last updated:** 2026-08-30

---

## What Is This?

A Tampermonkey userscript that auto-plays the Flappy Bird gambling game at `greenpump.xyz/flappy`. It detects the bird and pipe positions from the HTML canvas, flaps automatically, and cashes out at a configurable target score. There's also a local HTML simulation for testing without spending SOL.

---

## Quick Start

### To install the bot:
1. Install Tampermonkey browser extension
2. Open `flapper-bot.user.js` in the repo
3. Click "Raw" or copy the contents
4. Tampermonkey will prompt you to install it
5. Navigate to `https://greenpump.xyz/flappy`
6. The FlapMaster panel appears top-right

### To test locally:
1. Open `test_simulation.html` in a browser (via `127.0.0.1:3000` or file://)
2. Press **START** or **SPACE** to run the bot
3. Open console (F12) and run: `runAutoTest(100, "chill", "perfect")`

---

## Repository Structure

```
flapmaster/
├── flapper-bot.user.js          # Main Tampermonkey userscript (v5.5)
├── test_simulation.html         # Local HTML game simulation for testing
├── progress.md                  # Detailed project documentation & changelog
├── AGENTS.md                    # This file
├── scripts/                     # Browser console debugging tools
│   ├── capture_source.js        # Downloads all JS/CSS from the page
│   ├── capture_rsc.js           # Intercepts RSC streaming payloads
│   ├── download_dynamic.js      # Downloads dynamic Turbopack chunks (found game code!)
│   ├── download_missing.js      # Downloads missing chunks
│   ├── extract_modules.js       # Scans Turbopack module registry
│   ├── intercept_canvas.js      # Intercepts all canvas drawing operations
│   ├── inspect_game.js          # React fiber tree walker
│   ├── deep_inspect.js          # Deep game state inspector
│   ├── find_game_state.js       # Attempts to find React ref with bird/pipes
│   └── diagnostic.js            # Browser environment diagnostic
├── tools/
│   └── pull_source.py           # Python script to download site files
└── site_source/                 # Downloaded GreenPump website files
    ├── flappy.html              # Full server-rendered page HTML
    └── _next/static/chunks/     # JS/CSS bundles
        ├── 41qzff47zxjhm.js     # ** GAME CODE ** (module ID 53643)
        └── ...                   # Other bundles
```

---

## How the Bot Works

### Architecture

The bot runs entirely in the browser as a Tampermonkey userscript. It does NOT modify the game — it only reads the canvas pixels and simulates keyboard input (Space to flap, C/Enter to cashout).

### Detection Pipeline

1. **Bird Detection** — Scans canvas for bright lime-green pixel clusters (G>180, R<120, B<90). Uses flood-fill to find the bird cluster (15-150px, filters out bushes/trees which are 500+px). Bird X is fixed at ~120px from left.

2. **Pipe Detection** — Scans the right half of the canvas for dark teal vertical columns. Finds the gap (where dark pixels stop) to determine gapTop and gapBottom. Accounts for pipe caps (28px each side).

3. **Score Detection** — Score is rendered ON the canvas as white text at `(canvasWidth/2, 38)`. The bot tracks score by counting when the bird passes a pipe (bird X > pipe X + pipe width).

4. **Round Detection** — Detects active rounds by checking if the bird Y position is changing (velocity tracking via position history).

### Flap Algorithm (Current — v5.5)

The bot uses a **target-based approach**:

```
targetY = safeTop + (safeBot - safeTop) * 0.4   // upper 40% of safe zone

if (birdY > GROUND_Y - 80)           → FLAP (emergency: near ground)
if (birdY > targetY && birdVY >= 0)  → FLAP (below target and not rising)
otherwise                            → DON'T FLAP
```

The target is biased toward the top of the safe zone because the bird spends more time falling than rising (parabolic trajectory). The minimum interval between flaps prevents rapid-fire.

### Cashout Logic

When the bird passes a pipe, score increments. When `score >= targetPipes`, the bot presses C to cash out. The multiplier is calculated from the exact formula in the game source.

---

## Game Physics (EXACT from source)

These values were extracted from `site_source/_next/static/chunks/41qzff47zxjhm.js` (module ID 53643).

### Base Values

| Difficulty | Gap (px) | Speed | Gravity | Jump Force | Pipe Spacing | Max Fall Speed |
|------------|----------|-------|---------|------------|--------------|----------------|
| chill      | 114      | 3.31  | 0.28    | -6.1       | 203          | 6.6            |
| pump       | 110      | 3.44  | 0.29    | -6.2       | 201          | 6.8            |
| degen      | 105      | 3.59  | 0.30    | -6.3       | 198          | 7.0            |

### Dynamic Difficulty (increases per pipe passed)

- Speed: +0.028 per pipe (max +0.55)
- Gap: -0.19 per pipe (min 91px), extra -3 if "hot" formState
- Spacing: -0.29 per pipe (min 186px)

### Canvas Constants

- Dimensions: 940 x 580
- Ground level: y = 490 (580 - 90)
- Bird hitbox: radius 13 (circle)
- Pipe width: 68px (cap extends to 78px)
- Pipe cap height: 28px each side
- Safe zone = gapTop + 28 to gapBottom - 28

### Multiplier Formula

```javascript
function getMultiplier(difficulty, pipes) {
    if (pipes <= 0) return 1;
    if (pipes === 1) return 1.05;
    if (pipes === 2) return 1.07;
    if (pipes === 3) return 1.1;
    const base = difficulty === 'chill' ? 1.15 : difficulty === 'pump' ? 1.2 : 1.25;
    const step = difficulty === 'chill' ? 0.15 : difficulty === 'pump' ? 0.2 : 0.25;
    return Number((base + (pipes - 4) * step).toFixed(2));
}
```

---

## Bot Profiles

| Profile      | Accuracy | Miss Chance | Delay Variance | Min Interval |
|-------------|----------|-------------|----------------|--------------|
| PERFECT_BOT | 0.98     | 0.01        | 5ms            | 50ms         |
| HUMAN_PRO   | 0.85     | 0.05        | 25ms           | 60ms         |
| CASUAL      | 0.65     | 0.15        | 60ms           | 70ms         |
| DRUNK_MODE  | 0.40     | 0.35        | 150ms          | 90ms         |
| CHAOS       | 0.10     | 0.60        | 300ms          | 120ms        |

- **Accuracy**: Chance the bot flaps when it decides to
- **Miss Chance**: Chance the bot skips a planned flap (simulates human error)
- **Min Interval**: Minimum ms between flaps

---

## Key Findings from Reverse Engineering

### What we tried and failed:
- `window.game` — Does NOT exist
- React fiber tree — Too shallow (15 objects), no game state
- `useRef` access — Game state in `ee.current`, inaccessible from outside
- DOM score reading — Score is ONLY on canvas, not in DOM
- WebSocket interception — Game state not exposed via WS

### What works:
- Canvas pixel scanning for bird position (flood-fill cluster method)
- Canvas pixel scanning for pipe gap position (dark teal column detection)
- Keyboard simulation (Space, C, Enter)
- DOM overlay detection (state text like "Ready for Flight", "CASH OUT", etc.)

### API Endpoints
- `POST /api/flappy/start` — Needs bet_amount, difficulty, Solana TX signature
- `POST /api/flappy/cashout` — Cashes out current round
- `GET /api/flappy/history` — Round history
- `GET /api/flappy/leaderboard` — Top players

---

## Current State & Known Issues

### What works:
- Bird detection from canvas (reliable)
- Pipe gap detection from canvas (reliable)
- Flap algorithm (target-based, basic but functional in simulation)
- Auto-cashout at target pipes
- Panel UI (glassmorphism, draggable, minimizable)
- Preset profiles
- Debug mode with safe zone visualization
- Local simulation with exact physics

### What doesn't work / Known issues:
1. **Flap algorithm needs tuning** — The target-based approach works in simulation but may not be optimal for the real game. The bird oscillates around the target Y and can hit pipe caps.
2. **Full automation blocked** — Starting rounds requires Phantom wallet + SOL + TX signature. The bot can only play once a round is manually started.
3. **Canvas detection is fragile** — Will break if GreenPump updates their game graphics.
4. **Score detection is approximate** — Reading white pixels from canvas is imprecise.
5. **No adaptive strategy** — Bot doesn't adjust to dynamic difficulty changes during gameplay.

### What to work on next:
1. **Improve flap algorithm** — The current target-based approach is too simple. Consider:
   - Predictive trajectory simulation (account for multiple flaps)
   - Pipe-approach timing (adjust target based on distance to pipe)
   - Velocity-aware flapping ( flap harder when further from target)
2. **Better gap detection** — Current canvas scanning is basic. Could use edge detection or color clustering.
3. **Auto-restart** — Click "START FLIGHT" button automatically after cashout/crash (requires wallet to be connected).
4. **Score reading from canvas** — OCR-like approach to read the actual score number.
5. **Machine learning** — Train a model on game recordings to predict optimal flap timing.

---

## Testing

### Running the simulation
```bash
# Start a local server (Python)
cd "greenpump.xyz Flapper Script"
python -m http.server 3000

# Open in browser
# http://127.0.0.1:3000/test_simulation.html
```

### Running auto-test (in browser console)
```javascript
// Run 100 games with Perfect Bot on Chill
runAutoTest(100, "chill", "perfect")

// Run 100 games with Casual on Pump
runAutoTest(100, "pump", "casual")

// Run 500 games with Perfect Bot on Degen
runAutoTest(500, "degen", "perfect")
```

### Expected results (current v5.5)
- The bot should pass at least some pipes consistently
- Win rate depends on difficulty and profile
- If crash rate is 100% at score 0, the algorithm has a bug

---

## Browser Console Scripts

All scripts in `scripts/` are pasted into the browser console (F12 → Console) on `greenpump.xyz/flappy`.

**Most useful ones:**
- `download_dynamic.js` — Run this in the browser to download all dynamically-named Turbopack chunks. It found the game code in `41qzff47zxjhm.js`.
- `intercept_canvas.js` — Logs all `ctx.fillText`, `ctx.drawImage`, `ctx.fillRect` calls with coordinates. Useful for understanding what the game draws.
- `diagnostic.js` — Quick environment check (canvas, DOM, window globals).

---

## Git Workflow

```bash
# Make changes to flapper-bot.user.js or test_simulation.html
# Test in browser

# Commit and push
git add -A
git commit -m "Description of changes"
git push
```

---

## Dependencies

- **Tampermonkey** — Browser extension for running userscripts
- **Phantom Wallet** — Solana wallet (required to play the actual game)
- **Modern browser** — Chrome/Edge/Firefox with canvas support

No npm, no build step, no frameworks. Pure vanilla JS.

---

## File Map

| File | Purpose | Lines |
|------|---------|-------|
| `flapper-bot.user.js` | Main bot script (install in Tampermonkey) | ~900 |
| `test_simulation.html` | Local game simulation for testing | ~470 |
| `progress.md` | Full documentation & changelog | ~260 |
| `AGENTS.md` | This handoff document | ~250 |
| `site_source/.../41qzff47zxjhm.js` | Extracted game source code | N/A |

---

## Contact

If you have questions, check `progress.md` first — it has detailed changelogs and technical notes for every version.
