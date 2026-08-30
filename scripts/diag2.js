// FlapMaster v6.2 Diagnostic — paste into console on greenpump.xyz/flappy
// Run this WHILE A ROUND IS ACTIVE (bird is flying, pipes visible)
(function() {
    const canvas = document.querySelector('canvas');
    if (!canvas) { console.error('No canvas found'); return; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    console.log(`Canvas: ${w}x${h}`);

    // Test pipe detection with the NEW criteria
    console.log('\n=== PIPE DETECTION (g > r+30, bright pipes) ===');
    let colData = [];
    for (let x = 100; x < w - 5; x += 3) {
        let pipeYs = [];
        for (let y = 30; y < 490; y += 2) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            const r = d[0], g = d[1], b = d[2];
            const isGreenish = g > r + 30 && g > 60 && r < 180;
            const isDarkGreen = r < 70 && g < 110 && g > r && (g + r + b) / 3 < 70;
            if (isGreenish || isDarkGreen) pipeYs.push(y);
        }
        if (pipeYs.length > 5) colData.push({ x, count: pipeYs.length, minY: pipeYs[0], maxY: pipeYs[pipeYs.length-1] });
    }
    if (colData.length === 0) {
        console.log('  NO pipe columns found with g>r+30 criterion');
        console.log('  Sampling raw pixels from right side:');
        for (const sx of [300, 400, 500, 600, 700, 800]) {
            for (const sy of [100, 200, 300, 400]) {
                const d = ctx.getImageData(sx, sy, 1, 1).data;
                const r=d[0], g=d[1], b=d[2];
                const diff = g - r;
                console.log(`    (${sx},${sy}): rgb(${r},${g},${b}) g-r=${diff} ${diff>30?'← PIPE?':''}`);
            }
        }
    } else {
        console.log(`  Found ${colData.length} columns with pipe pixels`);
        console.log(`  Sample: x=${colData[0].x} count=${colData[0].count} y=${colData[0].minY}-${colData[0].maxY}`);
        console.log(`  Sample: x=${colData[Math.floor(colData.length/2)].x}`);
    }

    // Also test OLD criteria (brightness < 120)
    console.log('\n=== OLD CRITERIA (brightness < 120) ===');
    let oldCount = 0;
    for (let x = 300; x < w - 5; x += 10) {
        for (let y = 30; y < 490; y += 4) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            const b = (d[0] + d[1] + d[2]) / 3;
            if (b < 120 && d[1] > d[0] * 0.7) oldCount++;
        }
    }
    console.log(`  Dark-greenish pixels found: ${oldCount}`);

    // Bird detection test
    console.log('\n=== BIRD DETECTION (x=80-160) ===');
    for (let x = 80; x <= 160; x += 10) {
        let greenCount = 0;
        for (let y = 50; y < 490; y += 2) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            if (d[1] > 100 && d[1] > d[0] && d[1] > d[2]) greenCount++;
        }
        console.log(`  x=${x}: green pixels = ${greenCount}`);
    }

    // Full pixel dump at a few points
    console.log('\n=== RAW PIXELS ===');
    for (const [sx, sy] of [[120,250],[120,350],[300,100],[300,200],[300,350],[500,150],[500,300],[700,200],[700,350]]) {
        const d = ctx.getImageData(sx, sy, 1, 1).data;
        console.log(`  (${sx},${sy}): rgb(${d[0]},${d[1]},${d[2]}) g-r=${d[1]-d[0]}`);
    }
})();
