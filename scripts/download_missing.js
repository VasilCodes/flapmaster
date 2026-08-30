/**
 * Download Missing Game Chunks
 * Paste in browser console on greenpump.xyz/flappy
 */
(async () => {
    const chunks = [
        '3fntmmi971322.js',
        '41ov_0jhl6w1q.js', 
        '3w6qrnu4ggd00.js',
        '0fcp9kogr01_m.js',
        '1_fawx8qa7uia.js'
    ];
    
    console.log('=== Downloading Missing Game Chunks ===\n');
    
    for (const chunk of chunks) {
        const url = `/_next/static/chunks/${chunk}`;
        try {
            const r = await fetch(url, { credentials: 'include' });
            if (r.ok) {
                const text = await r.text();
                const blob = new Blob([text], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = chunk;
                a.click();
                console.log(`[OK] ${chunk} (${text.length} bytes)`);
            } else {
                console.log(`[FAIL] ${chunk} - ${r.status}`);
            }
        } catch (e) {
            console.log(`[ERROR] ${chunk} - ${e.message}`);
        }
        await new Promise(ok => setTimeout(ok, 300));
    }
    
    console.log('\nDone! Move downloaded files to:');
    console.log('G:\\Codes\\greenpump.xyz Flapper Script\\site_source\\_next\\static\\chunks\\');
})();
