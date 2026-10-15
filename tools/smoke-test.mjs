// Headless smoke test: opens the shell and every game from GAMES on iPhone 11/13/14 and reports any
// uncaught page error or console error. Dev tool only (not shipped/cached) — see CLAUDE.md's
// "Interactive/visual verification" for the Puppeteer setup this expects.
//
// Usage (repo root served over HTTP, e.g. `python3 -m http.server 8123`):
//   PUPPETEER_DIR=/tmp/pptr node tools/smoke-test.mjs [baseUrl]
// baseUrl defaults to http://localhost:8123/. Exit code is non-zero if any page reported an error.

import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire((process.env.PUPPETEER_DIR || '/tmp/pptr') + '/');
const puppeteer = require('puppeteer');
const { KnownDevices } = puppeteer;

const base = process.argv[2] || 'http://localhost:8123/';
const shellSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const gameUrls = shellSrc.split('\n').filter(l => !/^\s*\/\//.test(l))
  .flatMap(l => [...l.matchAll(/url:\s*'([^']+)'/g)].map(m => m[1]));
const pages = ['./index.html', ...gameUrls];
const devices = ['iPhone 11', 'iPhone 13', 'iPhone 14'];

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
let failures = 0;
for (const device of devices) {
  for (const url of pages) {
    const page = await browser.newPage();
    await page.emulate(KnownDevices[device]);
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    // Resource failures are reported via 'response' (with the URL) rather than the generic
    // console message; the browser's automatic /favicon.ico probe is ignored.
    page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push('console: ' + m.text()); });
    page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`http ${r.status()}: ${r.url()}`); });
    try {
      await page.goto(new URL(url, base).href, { waitUntil: 'load', timeout: 20000 });
      // Some games keep a request loop or animation going, so networkidle0 may never settle.
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      errors.push('load: ' + e.message);
    }
    if (errors.length) {
      failures++;
      console.log(`FAIL ${device} ${url}\n  ` + errors.join('\n  '));
    }
    await page.close();
  }
}
await browser.close();
console.log(failures ? `${failures} page(s) with errors` : `OK: ${pages.length} pages x ${devices.length} devices`);
process.exit(failures ? 1 : 0);
