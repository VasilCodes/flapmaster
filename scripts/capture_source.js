/**
 * Paste this in browser console on greenpump.xyz/flappy
 * It fetches all loaded JS/CSS and saves as downloads
 */
(async () => {
    const resources = performance.getEntriesByType('resource');
    const jsFiles = resources.filter(r => r.name.endsWith('.js'));
    const cssFiles = resources.filter(r => r.name.endsWith('.css'));
    
    console.log(`Found ${jsFiles.length} JS, ${cssFiles.length} CSS files`);
    
    async function download(url, filename) {
        try {
            const r = await fetch(url, { credentials: 'include' });
            const text = await r.text();
            const blob = new Blob([text], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            console.log(`  Downloaded: ${filename} (${text.length} bytes)`);
        } catch (e) {
            console.log(`  Failed: ${filename} - ${e.message}`);
        }
    }
    
    // Download all JS
    for (const r of jsFiles) {
        const name = r.name.split('/').pop().split('?')[0];
        await download(r.name, `js_${name}`);
        await new Promise(ok => setTimeout(ok, 200));
    }
    
    // Download all CSS
    for (const r of cssFiles) {
        const name = r.name.split('/').pop().split('?')[0];
        await download(r.name, `css_${name}`);
        await new Promise(ok => setTimeout(ok, 200));
    }
    
    console.log('Done! Check your downloads folder.');
})();
