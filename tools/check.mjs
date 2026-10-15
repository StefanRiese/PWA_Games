// Static checks for the shell and every game — run locally or in CI (.github/workflows/ci.yml).
// Dev tool only (not shipped/cached), no dependencies.
//
// Usage (from anywhere): node tools/check.mjs [--version-check]
//   --version-check  also fail if APP_VERSION wasn't bumped vs. the previous commit (HEAD~1) while
//                    that commit changed anything other than docs/tools/CI files. Needs git history.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const errors = [];
const fail = msg => errors.push(msg);

const commonJs = read('shared/common.js');
const shell = read('index.html');
// GAMES/GAME_RESETS lines, ignoring commented-out entries (e.g. a disabled game).
const liveLines = src => src.split('\n').filter(l => !/^\s*\/\//.test(l));

// ---------- 1. Syntax ----------
// Inline <script> blocks are matched non-greedily, i.e. up to the FIRST </script>, exactly like the
// browser's HTML parser — so a literal </script> inside a string/comment truncates the block here
// too and shows up as a syntax error instead of slipping through.
function checkHtmlScripts(path) {
  const src = read(path);
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) return fail(`${path}: no inline <script> block found`);
  // shared/common.js goes first so a reference to one of its globals is in scope, as in the page.
  const usesCommon = src.includes('shared/common.js');
  try {
    new Function((usesCommon ? commonJs + '\n' : '') + blocks.join('\n;\n'));
  } catch (e) {
    fail(`${path}: inline script doesn't parse — ${e.message}`);
  }
}
for (const path of ['sw.js', 'shared/common.js']) {
  try { new Function(read(path)); } catch (e) { fail(`${path}: doesn't parse — ${e.message}`); }
}
try { JSON.parse(read('manifest.json')); } catch (e) { fail(`manifest.json: invalid JSON — ${e.message}`); }

const gameDirs = readdirSync(ROOT).filter(d =>
  !d.startsWith('.') && !['shared', 'tools'].includes(d) &&
  statSync(join(ROOT, d)).isDirectory() && existsSync(join(ROOT, d, 'index.html')));
checkHtmlScripts('index.html');
for (const d of gameDirs) checkHtmlScripts(`${d}/index.html`);

// ---------- 2. Consistency ----------
// GAMES entries: every url exists, every game folder is listed, ids are unique.
const games = liveLines(shell.slice(shell.indexOf('const GAMES = ['), shell.indexOf('const GAME_RESETS')))
  .filter(l => /\{\s*id:\s*'/.test(l))
  .map(l => ({
    id: l.match(/id:\s*'([^']+)'/)?.[1],
    category: l.match(/category:\s*'([^']+)'/)?.[1],
    descKey: l.match(/descKey:\s*'([^']+)'/)?.[1],
    url: l.match(/url:\s*'([^']+)'/)?.[1],
  }));
if (!games.length) fail('index.html: no GAMES entries found');
const seenIds = new Set();
for (const g of games) {
  if (!g.id || !g.descKey || !g.url) { fail(`GAMES entry ${g.id || '?'}: missing id/descKey/url`); continue; }
  if (seenIds.has(g.id)) fail(`GAMES: duplicate id '${g.id}'`);
  seenIds.add(g.id);
  if (!existsSync(join(ROOT, g.url))) fail(`GAMES '${g.id}': url ${g.url} doesn't exist`);
}
const listedDirs = new Set(games.map(g => g.url.replace(/^\.\//, '').split('/')[0]));
for (const d of gameDirs) if (!listedDirs.has(d)) fail(`${d}/: game folder not listed in GAMES`);

// Every descKey/category label is translated in both languages.
let I18N = null;
try {
  const start = shell.indexOf('const I18N = {');
  const end = shell.indexOf('\n    };', start);
  I18N = new Function('return ' + shell.slice(start + 'const I18N = '.length, end + 6))();
} catch (e) {
  fail(`index.html: couldn't evaluate the I18N object — ${e.message}`);
}
const categories = [...shell.slice(shell.indexOf('const CATEGORIES = ['), shell.indexOf('];', shell.indexOf('const CATEGORIES = [')))
  .matchAll(/id:\s*'([^']+)',\s*labelKey:\s*'([^']+)'/g)].map(m => ({ id: m[1], labelKey: m[2] }));
if (I18N) {
  const keys = [...games.map(g => g.descKey), ...categories.map(c => c.labelKey)];
  for (const lang of ['de', 'en']) {
    for (const k of keys) if (!I18N[lang] || !I18N[lang][k]) fail(`index.html: I18N.${lang} is missing '${k}'`);
  }
}
for (const g of games) {
  if (g.category && !categories.some(c => c.id === g.category)) fail(`GAMES '${g.id}': unknown category '${g.category}'`);
}

// Each game wires in the shared files and reads the shell's theme/language prefs.
const storageKeys = new Map();
for (const d of gameDirs) {
  const src = read(`${d}/index.html`);
  if (!src.includes('href="../shared/common.css"')) fail(`${d}/index.html: doesn't load ../shared/common.css`);
  if (!src.includes('src="../shared/common.js"')) fail(`${d}/index.html: doesn't load ../shared/common.js`);
  // loadShellPrefs() is the norm; Pinball reads pwa_games_v1 itself (its `state` name is taken).
  const code = src.replace(/\/\/.*$/gm, '');
  if (!/loadShellPrefs\(\)/.test(code) && !code.includes('pwa_games_v1')) fail(`${d}/index.html: never reads the shell prefs (loadShellPrefs())`);
  const key = src.match(/STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!key) continue;
  if (key === 'pwa_games_v1') fail(`${d}/index.html: uses the shell's own storage key`);
  if (storageKeys.has(key)) fail(`${d}/index.html: STORAGE_KEY '${key}' also used by ${storageKeys.get(key)}/`);
  storageKeys.set(key, d);
}

// GAME_RESETS entries point at a real game and its real storage key.
const resets = liveLines(shell.slice(shell.indexOf('const GAME_RESETS = ['), shell.indexOf('const CATEGORIES')))
  .map(l => l.match(/id:\s*'([^']+)'.*storageKey:\s*'([^']+)'/)).filter(Boolean).map(m => ({ id: m[1], key: m[2] }));
for (const r of resets) {
  if (!seenIds.has(r.id)) fail(`GAME_RESETS '${r.id}': not a GAMES id`);
  if (!storageKeys.has(r.key)) fail(`GAME_RESETS '${r.id}': storageKey '${r.key}' isn't any game's STORAGE_KEY`);
}

// APP_VERSION is semver.
const version = shell.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail(`index.html: APP_VERSION '${version}' isn't semver`);

// Optional: APP_VERSION bumped vs. the previous commit (the update flow only notices a new deploy
// through a changed APP_VERSION, so an unbumped deploy never reaches installed apps).
if (process.argv.includes('--version-check')) {
  const git = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let prev = null, changed = [];
  try {
    prev = git('git show HEAD~1:index.html').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
    changed = git('git diff --name-only HEAD~1 HEAD').split('\n').filter(Boolean);
  } catch {
    console.log('version check skipped: no previous commit available');
  }
  const relevant = changed.filter(f => !/\.md$/.test(f) && !f.startsWith('tools/') && !f.startsWith('.github/'));
  if (prev && relevant.length) {
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
    if (!version || cmp(version, prev) <= 0) fail(`APP_VERSION ${version} not bumped above ${prev} (changed: ${relevant.join(', ')})`);
  }
}

if (errors.length) {
  console.log(errors.map(e => '✗ ' + e).join('\n'));
  console.log(`\n${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`OK: ${gameDirs.length} games, ${games.length} GAMES entries, version ${version}`);
