# Flapper Bot - Progress & Documentation

## Project Overview
Tampermonkey userscript that auto-plays the Flappy Bird game on greenpump.xyz/flappy

## Project Structure

```
greenpump.xyz Flapper Script/
├── flapper-bot.user.js      # Main Tampermonkey script (v5.2)
├── progress.md              # This file
├── scripts/                 # Browser console scripts
│   ├── inspect_game.js      # React fiber tree walker
│   ├── deep_inspect.js      # Deep game state inspector
│   ├── capture_rsc.js       # RSC payload interceptor
│   ├── capture_source.js    # Downloads all JS/CSS from page
│   ├── download_missing.js  # Downloads missing game chunks
│   ├── download_dynamic.js  # Downloads dynamic chunks (FOUND GAME CODE!)
│   ├── extract_modules.js   # Scans Turbopack module registry
│   ├── intercept_canvas.js  # Intercepts canvas drawing operations
│   └── diagnostic.js        # Browser environment diagnostic
├── tools/                   # Python utilities
│   └── pull_source.py       # Downloads site source files
└── site_source/             # Downloaded website files
    ├── flappy.html          # Full page HTML
    └── _next/static/chunks/ # JS/CSS bundles (including game code!)
```

## Browser Console Scripts

All scripts in `scripts/` are pasted into the browser console (F12 → Console) on `greenpump.xyz/flappy`.

**Run in order:**
1. `capture_source.js` — Downloads all JS/CSS (run first)
2. `capture_rsc.js` — Intercepts streaming game code (paste before reload)
3. `inspect_game.js` — Basic React fiber inspection
4. `deep_inspect.js` — Deep game state inspection

---

## Browser Diagnostic Results (2026-08-30)

### Environment
- Browser: Chrome 152 on Windows 10
- URL: https://greenpump.xyz/flappy

### Canvas
- Single canvas: 940x580, no ID/class
- Context: 2D available
- Score is rendered ON canvas (not DOM) - white text at top-center

### DOM Structure
- `.flappy-arena-grid` found, 2 children (game area + controls sidebar)
- Game area contains: canvas + overlay div (with "Ready for Flight" text)
- Controls sidebar contains: bet amount input, START FLIGHT button, leaderboard

### Buttons Found
| Index | Text | Notes |
|-------|------|-------|
| 17 | START FLIGHT (SOL) | Main start button |
| 18 | START FLIGHT (0.01 SOL) | Mobile sticky bar |
| 11-16 | 0.005, 0.05, 0.1, 0.25, 0.5, 1 | Bet amount quick-select |
| 19-22 | START, STOP, Force, Crash | Our bot's buttons |

### Input Fields
| Index | Type | Value | Notes |
|-------|------|-------|-------|
| 1 | number | 0.005 | Bet amount input (game's) |
| 2-5 | range | 65,15,60,100 | Bot custom sliders |
| 6-7 | number/range | 3 | Target pipes |

### Window Globals
- NO `window.game` - game state is in React useRef (ee.current)
- NO `#__next` element - React fiber not accessible
- NO score elements in DOM

### Overlay States
- "Ready for Flight" - idle state, waiting for bet
- "START FLIGHT" - button text
- "CASH OUT" - during play
- "FLIGHT CRASHED" - game over
- "CASHED OUT" - successful cashout

### Wallet
- Phantom wallet: NOT connected (balance 0.0000)
- Need wallet connected + SOL balance to start rounds

---

## Game Architecture (EXACT from source: 41qzff47zxjhm.js)

### Game States
- `idle` - waiting for bet, overlay visible
- `countdown` - 3-2-1 countdown after bet placed
- `playing` - active gameplay
- `cashed_out` - successfully cashed out
- `crashed` - bird died

### Game Physics (CORRECTED from source)
| Difficulty | Gap | Speed | Gravity | Jump Force | Pipe Spacing | Max Fall |
|------------|-----|-------|---------|------------|--------------|----------|
| chill | 114px | 3.31 | 0.28 | -6.1 | 203px | 6.6 |
| pump | 110px | 3.44 | 0.29 | -6.2 | 201px | 6.8 |
| degen | 105px | 3.59 | 0.30 | -6.3 | 198px | 7.0 |

### Dynamic Difficulty (increases during gameplay)
- Speed: +0.028 per pipe passed (max +0.55)
- Gap: -0.19 per pipe passed (min 91px), extra -3 if "hot" formState
- Spacing: -0.29 per pipe passed (min 186px)

### Canvas
- Dimensions: 940x580
- Ground level: y=490 (580-90)
- Bird hitbox: radius 13 (26x26 circle)
- Pipe width: 68px (cap: 78px)
- Bird image: 54x37 pixels from /flappy-bird.png

### Multiplier Calculation (EXACT from source)
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

| Pipes | Chill | Pump | Degen |
|-------|-------|------|-------|
| 0 | 1.00x | 1.00x | 1.00x |
| 1 | 1.05x | 1.05x | 1.05x |
| 2 | 1.07x | 1.07x | 1.07x |
| 3 | 1.10x | 1.10x | 1.10x |
| 4 | 1.15x | 1.20x | 1.25x |
| 5 | 1.30x | 1.40x | 1.50x |
| 10 | 2.05x | 2.40x | 2.75x |
| 20 | 3.55x | 4.40x | 5.25x |

---

## Bot Detection Strategy

### 1. Overlay Detection
- Check DOM for "Ready for Flight" text
- Check for START FLIGHT button visibility
- Check overlay CSS classes

### 2. Round Active Detection
- Overlay disappears
- Canvas shows bird pixel movement (bird Y changes > 5px over 5+ frames)
- Game over overlay NOT visible

### 3. Score Detection (Canvas-Based)
- Scan top-center of canvas (x: 420-520, y: 30-80) for white pixels
- Count white pixel clusters to estimate digit count
- Or: detect score changes by monitoring pixel changes in score area

### 4. Bird Position Detection (Canvas-Based)
- Scan canvas for bird-colored pixels (green/yellow: R>150, G>180, B<100)
- Bird is typically in left portion of canvas (x: 50-250)
- Average bird pixel positions for Y coordinate

### 5. Gap Detection (Canvas-Based)
- Look for vertical dark columns (pipe walls) ahead of bird
- Find gap between pipe pairs
- Scan for brightness in gap area to find center Y

---

## Known Limitations

1. **No React state access** - Can't read game state directly from React refs
2. **No DOM score** - Must read score from canvas (imprecise)
3. **Wallet required** - Can't start rounds without Phantom wallet + SOL
4. **API signature required** - Each start needs a unique Solana TX signature
5. **Canvas pixel detection is fragile** - Breaks if game updates graphics

---

## Changelog

### v7.3 (2026-08-31) — Flap algorithm fix (69% win rate on chill)

**Root cause of 0% win rate:**
The flap target was `gapCenter - 5` (5px above center). Each flap rises
~66px. From 5px above center, the bird overshoots to 61px above center —
past the gap top (57px above center for a 114px gap). The bird oscillates
with unstable amplitude and always clips a pipe cap.

**Fix:**
Changed target from `gapCenter - 5` to `gapCenter + 20`. Bird now flaps
when 20px BELOW center, rising to 46px above center — safely within the
57px half-gap. Verified by 5000-game Monte Carlo simulation:

| Difficulty | Win Rate (>=3) | Avg Pipes | Max |
|------------|----------------|-----------|-----|
| chill      | 69%            | 6.3       | 30  |
| pump       | 43%            | 3.0       | 28  |
| degen      | 8%             | 0.7       | 12  |

Degen is poor because the gap (105px) barely fits the 66px rise.

### v7.2 (2026-08-31) — Round detection + bird detection fixes

- isRoundActive: when round already active, skip history check
- Bird detection: removed isPipe filter (bird green was classified as pipe)
- Bird detection: use predicted y to narrow scan range (±30px)
- Bird physics: initialize at game start position when round begins
- Sky detection: blue-based (b>140, |g-b|<60) instead of brightness-based
- Pipe detection: g > r+20 AND g > b+30
- One-shot color diagnostic on first frame
- Reduced per-frame console.log to debug mode or every 60 frames
- Added @run-at document-start + willReadFrequently monkey-patch

### v7.0 (2026-08-31) — Complete rewrite from v6.5

- Removed 2-action planner (heurFlap/rolloutFlapAt)
- New sky detection: blue-based (b>140, |g-b|<60) — fixed cyan sky bug
- New pipe detection: g > r+20 AND g > b+30 (green dominates both)
- New bird detection: scan strip x=90-150 for !isSky pixels only
- Flap rule: bird below gap center AND falling → flap

### v6.0 (2026-08-31) — Flap algorithm rewrite + critical bug fixes

**Root cause of "bird always just flies up" (and everything else looking broken):**

Two categories of bugs made the bot completely non-functional:

*Crashes that prevented the script from running at all:*
- `flapper-bot.user.js` had a **`SyntaxError`**: `targetY` was declared
  twice (`let` then `const`) in the same scope inside `gameLoop()`. A
  `SyntaxError` anywhere prevents the ENTIRE script from being parsed —
  so the bot (including the panel) never loaded in the browser.
- Even after fixing that, `readBirdPosition()` referenced `now` which only
  existed in `gameLoop()`'s scope → `ReferenceError` the instant the bird
  was detected.

*Algorithm bug that would cause "always flies up" even if crashes were fixed:*
- One flap raises the bird `jumpForce²/(2*gravity)` ≈ **66.4px**. The old
  bot's "safe zone" was only **58px** tall (it used `PIPE_CAP = 28` as a
  margin, but PIPE_CAP is a *drawing* detail — actual collision uses
  `BIRD_R = 13`, giving an 88px band). Aiming 40% from the top of the
  58px zone and flapping there guaranteed punching through the top pipe.
- The velocity estimate came from noisy `Date.now()` deltas between canvas
  scans. Any lag spike could leave the velocity sign wrong for multiple
  frames, causing repeated unnecessary flaps → bird rockets to ceiling.

*Simulation bugs:*
- `runAutoTest` had **two copies** of the bot logic per frame (only the
  first was logged), effectively doubling the flap rate.
- `runAutoTest` hardcoded the bird at `x=13` while the real sim uses
  `x=120`, so the autotest wasn't testing the same game.

**Fixes:**

*Crash fixes:*
- Removed the duplicate `targetY` declaration and fixed `nextPipe`/`now`
  out-of-scope bugs. Script now parses and runs.
- Bird is now tracked as a real physics object (`state.bird = {x, y, vy}`):
  canvas scans provide a *sample*; position/velocity are integrated with
  gravity every frame and corrected (not replaced) by that sample. On flap,
  `vy` is set to `jumpForce` immediately — this stops runaway re-flapping.
- Pipe detection looks ahead up to 3 pipes (`LOOKAHEAD_PIPES = 3`).

*Algorithm rewrite — planner replaces fixed threshold:*
- **Short-horizon planner** (`PLAN_HORIZON = 200`): every frame, simulates
  both "flap now" and "coast now" for 200 frames using the same physics.
  Keeps whichever survives longer. This solves the phase-matching problem
  that a fixed flap threshold cannot — 66px rise in an 88px band demands
  proper planning.
- **Heuristic fallback** (`heurFlap`): when both actions survive the full
  horizon, the planner falls back to oscillating the bird centred on the
  gap centre (`gapCenter + rise/2`), clamped inside a margin. This is
  much better than the old "40% from top" which was always too high.
- **Removed `minInterval`** entirely (profiles, config, UI). The planner
  is naturally self-limiting: flapping sets vy negative, so "coast" wins
  the next rollout and we don't flap again until actually falling.

*Simulation fixes:*
- Removed the duplicated bot block in `runAutoTest` — one decision per
  frame only.
- Fixed `runAutoTest` bird x-position from 13 → `BIRD_X` (120).

**Empirical results (headless, 300 games each, PERFECT bot):**

| Target | OLD (chill) | NEW chill | NEW pump | NEW degen |
|--------|-------------|-----------|----------|-----------|
| 3 pipes | **0%** | **97%** | **96%** | **94%** |
| 5 pipes | 0% | 90% | 86% | 79% |
| 10 pipes | 0% | 70% | 65% | 52% |
| 20 pipes | 0% | 45% | 31% | 16% |

### v6.2 (2026-08-31) — Planner speed fix + pipe detection improvements + debug overlay

**Bug fixes:**
- `rolloutFlapAt` in the live bot used constant `d.speed` for pipe movement
  in the planner simulation, while the real game uses `speed + min(0.55, 0.028 * score)`.
  This made the planner underestimate pipe approach speed at higher scores.
  Fixed by passing `spd` parameter through `botShouldFlap` → `rolloutFlapAt`.
- `readPipes` scan started at `birdX + 20`, missing pipes the bird was
  already overlapping. Changed to `birdX - BIRD_RADIUS - 5`.
- Added pipe grace logic: if no pipes detected this frame but we had
  recent ones (< 800ms), keep using cached pipes so the planner doesn't
  lose its target during brief detection drops.

**Pipe detection rewrite:**
- Rewrote `readPipes` to group nearby x-columns into pipe candidates,
  then find the largest gap in each candidate. More robust than the old
  per-column approach.
- Widened detection criteria: brightness < 120 AND greenish (g > r * 0.6)
- Scan every 3px horizontally (was 4px) for better resolution
- Added debug overlay: when debug mode is on, draws gap lines + center
  dots on the canvas so you can see what the bot detects

**Empirical results (headless, 500 games, 1% miss):**

| Target | chill | pump | degen |
|--------|-------|------|-------|
| 3 pipes | 96% | 95% | 90% |
| 5 pipes | 90% | 85% | 77% |
| 10 pipes | 72% | 64% | 48% |

### v5.4 (2026-08-30)
**Removed non-working features:**
- Removed Auto-restart rounds checkbox
- Removed Manual flap checkbox
- Simplified panel

**Added pipe detection from canvas:**
- Scans right half of canvas for dark teal pipe columns
- Detects gap position (where dark pixels stop)
- Calculates target Y based on next pipe's gap center
- Flap when bird is below gap center
- Hold when bird is above gap center (let gravity work)
- Emergency flap when bird way below gap

### v5.2 (2026-08-30)
**Updated with EXACT source code values from 41qzff47zxjhm.js:**
- Fixed gap size: 114 (chill), 110 (pump), 105 (degen)
- Fixed pipe spacing: 203, 201, 198
- Fixed speed: 3.31, 3.44, 3.59
- Added dynamic difficulty: speed +0.028/pipe, gap -0.19/pipe, spacing -0.29/pipe
- Added dynamic gap shrinking (min 91px)
- Added dynamic spacing shrinking (min 186px)
- Fixed multiplier table with exact formula
- Added canvas constants: 940x580, ground=490, bird radius=13, pipe width=68
- Updated flap algorithm to use play area center (y=245)

### v5.1 (2026-08-30)
**Bird detection improvements:**
- Flood-fill cluster detection to distinguish bird from background
- Bird = bright lime green (G>180, R<120, B<90), small cluster (15-150px)
- Bushes = darker green, large clusters (500+px) - filtered out
- Picks cluster closest to canvas center Y
- Added birdX tracking

**Flap algorithm improvements:**
- Uses documented gap size (111px) centered at canvasH/2
- Gap range: y=235 to y=345
- Flap when bird falls below gap center (diff > 30)
- Emergency flap when bird way below gap (diff > 200)
- Reduced miss chance threshold (0.3 instead of 0.4)

### v5.0 (2026-08-30)
**Cleanup release - removed fake/unreliable features:**
- REMOVED: Difficulty selector (game controls this, not bot)
- REMOVED: Bet amount input (game controls this, requires Phantom wallet)
- REMOVED: Canvas score reading (too imprecise, was fake)
- REMOVED: Gap detection from canvas pixels (unreliable)
- REMOVED: Velocity tracking (imprecise without game state)
- REMOVED: `window.game` detection (confirmed not available)
- REMOVED: React fiber attempts (confirmed not accessible)
- REMOVED: `DIFFICULTY` constants (not used)
- SIMPLIFIED: Flap algorithm - now uses bird Y position vs canvas center
- SIMPLIFIED: Round detection - bird movement tracking only
- KEPT: Preset profiles (control bot behavior)
- KEPT: Target pipes (when to cashout)
- KEPT: Auto-restart (clicks START FLIGHT)
- KEPT: Manual flap mode
- KEPT: Debug mode
- KEPT: Start/Stop/Force/Crash buttons
- KEPT: Log, Stats, Minimize
- KEPT: KEY C + ENTER cashout with retry

### v4.0 (previous)
- Multi-strategy game state detection
- Canvas pixel scanning for bird + gap
- Auto-restart implementation
- KEY C + ENTER cashout with retry
- Session stats tracking
- MutationObserver for overlay
- Element retry mechanism
- Emergency flap mode

### v3.4 (original)
- Basic auto-flap
- Single canvas pixel scan
- UI panel with cyber theme
