"""
GreenPump Source Puller
Downloads all HTML, CSS, JS from greenpump.xyz/flappy for analysis.
"""

import os
import re
import requests
from urllib.parse import urljoin, urlparse
from pathlib import Path

BASE = "https://greenpump.xyz"
URL = f"{BASE}/flappy"
OUT_DIR = Path(__file__).parent / "site_source"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
}

def fetch(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        return r.text, r.headers.get("content-type", "")
    except Exception as e:
        print(f"  [FAIL] {url} - {e}")
        return None, ""

def save(rel_path, content):
    path = OUT_DIR / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"  [SAVED] {rel_path}")

def extract_urls(html, base_url):
    urls = set()
    # src="..." and href="..."
    for match in re.finditer(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', html):
        u = match.group(1)
        if u.startswith(("data:", "javascript:", "#")):
            continue
        full = urljoin(base_url, u)
        if urlparse(full).netloc in ("greenpump.xyz", ""):
            urls.add(full)
    # url(...) in CSS
    for match in re.finditer(r'url\(["\']?([^"\')\s]+)["\']?\)', html):
        u = match.group(1)
        if u.startswith(("data:", "#")):
            continue
        full = urljoin(base_url, u)
        if urlparse(full).netloc in ("greenpump.xyz", ""):
            urls.add(full)
    return urls

def extract_js_urls_from_next(html):
    """Extract Next.js chunk URLs from inline scripts."""
    urls = set()
    for match in re.finditer(r'src\s*[:=]\s*["\']([^"\']+\.js)["\']', html):
        u = match.group(1)
        full = urljoin(BASE, u)
        urls.add(full)
    return urls

def main():
    print(f"=== GreenPump Source Puller ===\nTarget: {URL}\nOutput: {OUT_DIR}\n")

    # 1. Fetch main page
    html, _ = fetch(URL)
    if not html:
        print("Failed to fetch main page.")
        return

    save("flappy.html", html)

    # 2. Find all linked resources
    all_urls = extract_urls(html, URL)
    all_urls |= extract_js_urls_from_next(html)

    # 3. Categorize
    css_urls = sorted(u for u in all_urls if u.endswith(".css"))
    js_urls = sorted(u for u in all_urls if u.endswith(".js"))
    img_urls = sorted(u for u in all_urls if any(u.endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".svg", ".ico", ".gif", ".webp"]))

    print(f"Found: {len(css_urls)} CSS, {len(js_urls)} JS, {len(img_urls)} images\n")

    # 4. Download CSS
    print("--- CSS ---")
    for url in css_urls:
        rel = urlparse(url).path.lstrip("/")
        content, ctype = fetch(url)
        if content:
            save(rel, content)

    # 5. Download JS
    print("\n--- JS ---")
    for url in js_urls:
        rel = urlparse(url).path.lstrip("/")
        content, ctype = fetch(url)
        if content:
            save(rel, content)

    # 6. Download images (optional, skip if too many)
    if len(img_urls) <= 30:
        print("\n--- IMAGES ---")
        for url in img_urls:
            rel = urlparse(url).path.lstrip("/")
            content, ctype = fetch(url)
            if content:
                path = OUT_DIR / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                mode = "wb" if "image" in ctype else "w"
                with open(path, mode) as f:
                    f.write(content if mode == "w" else content.encode() if isinstance(content, str) else content)
                print(f"  [SAVED] {rel}")

    # 7. Summary
    total = sum(1 for _ in OUT_DIR.rglob("*") if _.is_file())
    print(f"\n=== Done. {total} files saved to {OUT_DIR} ===")

if __name__ == "__main__":
    main()
