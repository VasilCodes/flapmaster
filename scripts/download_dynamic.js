/**
 * Download Dynamic Chunks
 * The game code is in dynamically-named chunks like 1z98reo8lawur.js
 * This script finds and downloads them all
 * Paste in browser console on greenpump.xyz/flappy
 */
(async () => {
    console.log('=== Dynamic Chunk Downloader ===\n');

    // 1. Find all loaded script sources
    const scripts = [...document.querySelectorAll('script[src]')];
    const nextScripts = scripts.filter(s => s.src.includes('_next'));

    console.log(`Found ${nextScripts.length} Next.js scripts:\n`);

    let chunks = [];
    for (const s of nextScripts) {
        const url = s.src;
        const name = url.split('/').pop();
        chunks.push({ url, name });
        console.log(`  ${name}`);
    }

    // 2. Also check performance entries for any we missed
    const perfEntries = performance.getEntriesByType('resource');
    const jsEntries = perfEntries.filter(e =>
        e.name.includes('_next') && e.name.endsWith('.js')
    );

    for (const e of jsEntries) {
        const name = e.name.split('/').pop().split('?')[0];
        if (!chunks.find(c => c.name === name)) {
            chunks.push({ url: e.name, name });
            console.log(`  [perf] ${name}`);
        }
    }

    console.log(`\nTotal unique chunks: ${chunks.length}\n`);

    // 3. Download each one
    console.log('Downloading...\n');

    for (const chunk of chunks) {
        try {
            const r = await fetch(chunk.url, { credentials: 'include' });
            if (r.ok) {
                const text = await r.text();
                // Check if it has game code
                const hasGame = /bird|pipe|gravity|canvas|requestAnimationFrame|drawImage|fillRect/i.test(text);
                const marker = hasGame ? ' *** GAME CODE ***' : '';

                // Save as download
                const blob = new Blob([text], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = chunk.name;
                a.click();

                console.log(`[OK] ${chunk.name} (${text.length}B)${marker}`);
            } else {
                console.log(`[FAIL] ${chunk.name} - ${r.status}`);
            }
        } catch (e) {
            console.log(`[ERROR] ${chunk.name} - ${e.message}`);
        }
        await new Promise(ok => setTimeout(ok, 200));
    }

    console.log('\nDone! Move all files to:');
    console.log('G:\\Codes\\greenpump.xyz Flapper Script\\site_source\\_next\\static\\chunks\\');
})();
