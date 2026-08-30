/**
 * RSC Payload Capture
 * Paste in browser console on greenpump.xyz/flappy BEFORE loading the game
 * Then reload the page - it will capture the streaming game code
 */
(() => {
    console.log('=== RSC Payload Capture ===\n');

    // Intercept fetch to capture RSC responses
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const resp = await origFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        // Capture RSC payloads
        if (url.includes('_next') || url.includes('rsc') || resp.headers.get('rsc')) {
            const clone = resp.clone();
            const text = await clone.text();
            if (text.length > 100) {
                console.log(`\n[RSC] ${url.slice(0, 80)} (${text.length} bytes)`);
                // Save to window for inspection
                if (!window.__rsc_payloads) window.__rsc_payloads = [];
                window.__rsc_payloads.push({ url, text });
            }
        }
        return resp;
    };

    // Also intercept XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._url = url;
        return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (this._url && (this._url.includes('_next') || this._url.includes('rsc'))) {
                if (this.responseText && this.responseText.length > 100) {
                    console.log(`\n[XHR] ${this._url.slice(0, 80)} (${this.responseText.length} bytes)`);
                    if (!window.__rsc_payloads) window.__rsc_payloads = [];
                    window.__rsc_payloads.push({ url: this._url, text: this.responseText });
                }
            }
        });
        return origSend.apply(this, args);
    };

    console.log('Interceptors installed. Now:');
    console.log('1. Reload the page');
    console.log('2. Wait for game to load');
    console.log('3. Run: window.__rsc_payloads');
    console.log('4. Look for payloads containing "bird", "pipe", "game"');
})();
