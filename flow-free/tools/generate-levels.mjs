#!/usr/bin/env node
// Offline level pregenerator for Flow Free.
//
// A level's entire layout (grid size + every color's dot pair) is derived purely from its level
// number via a seeded random number generator, so regenerating the same level number always
// produces byte-identical output — same reproducibility requirement, and same reasons, as Arrow
// Escape's generator (see arrow-escape/tools/generate-levels.mjs and CLAUDE.md's "Arrow Escape
// level generator" section).
//
// Unlike Arrow Escape, Flow Free's puzzle IS its own solution by construction: the generator
// builds a single Hamiltonian path over the entire n x n grid (visiting every cell exactly once),
// then cuts that path into `pairCount` contiguous segments. Each segment's two ends become one
// color's dot pair; the segment's interior cells are never shipped to the browser at all — only
// the endpoints are. This is provably solvable and full-board-covering by construction (the
// segments are disjoint contiguous slices of one simple path whose union is every cell exactly
// once, which is exactly Flow Free's win condition), so no separate solver/verification pass is
// needed the way Arrow Escape's LevelSolver is.
//
// Writes a directory of small per-level-range JSON chunk files (plus a manifest.json), matching
// Arrow Escape's exact chunking scheme, for the game to fetch() on demand.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// PRNG — copied verbatim from arrow-escape/tools/generate-levels.mjs. A Multiply-with-Carry
// generator over a 64-bit state, seeded via a Thomas Wang 64-bit integer mix, implemented with
// BigInt masked to 64 bits after every op that can overflow, to get exact 64-bit
// wraparound-on-overflow arithmetic regardless of JS engine — needed so a level's exact layout is
// reproducible byte-for-byte from just its level number, on any engine.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xffffffffn;
const POW2_27_D = 134217728;
const POW2_53_D = 9007199254740992;

function setupSeed(nIn) {
  let n = BigInt.asUintN(64, nIn);
  n = BigInt.asUintN(64, (MASK64 - n) + BigInt.asUintN(64, n << 21n));
  n = n ^ (n >> 24n);
  n = BigInt.asUintN(64, n * 265n);
  n = n ^ (n >> 14n);
  n = BigInt.asUintN(64, n * 21n);
  n = n ^ (n >> 28n);
  n = BigInt.asUintN(64, n + BigInt.asUintN(64, n << 31n));
  if (n === 0n) n = 0x5a17n;
  return n;
}

class SeededRandom {
  constructor(seed) {
    this.state = setupSeed(BigInt(seed));
    this._nextState();
    this._nextState();
    this._nextState();
    this._nextState();
  }

  _nextState() {
    const A = 0xffffda61n;
    const lo = this.state & MASK32;
    const hi = this.state >> 32n;
    this.state = BigInt.asUintN(64, A * lo + hi);
  }

  nextInt(max) {
    if (!(max > 0)) throw new RangeError('max must be positive');
    if ((max & -max) === max) {
      this._nextState();
      return Number(this.state & MASK32) & (max - 1);
    }
    let rnd32, result;
    do {
      this._nextState();
      rnd32 = Number(this.state & MASK32);
      result = rnd32 % max;
    } while (rnd32 - result + max > 4294967296);
    return result;
  }

  nextDouble() {
    return (this.nextInt(1 << 26) * POW2_27_D + this.nextInt(1 << 27)) / POW2_53_D;
  }
}

// Fisher-Yates, in place. Unlike Arrow Escape's `deterministicSort`, this needs no custom sort
// algorithm to stay engine-independent: it never calls `rng` from inside a comparator, so its
// determinism comes purely from the fixed loop structure and `rng.nextInt()` call sequence, both
// already engine-independent on their own.
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Difficulty tiers — grid size and pair count always match (see "cutIntoSegments" below for why
// that keeps segment-length distribution trivial), spanning a fixed, contiguous slice of the
// global 1..300 level numbering.
// ---------------------------------------------------------------------------

const TIERS = [
  { id: 'easy', n: 5, pairCount: 5, start: 1, end: 100 },
  { id: 'medium', n: 7, pairCount: 7, start: 101, end: 200 },
  { id: 'hard', n: 9, pairCount: 9, start: 201, end: 300 },
];

function tierForLevel(levelNumber) {
  const tier = TIERS.find((t) => levelNumber >= t.start && levelNumber <= t.end);
  if (!tier) throw new RangeError(`no tier configured for level ${levelNumber}`);
  return tier;
}

// ---------------------------------------------------------------------------
// Hamiltonian path construction — randomized DFS with a Warnsdorff-style (fewest-remaining-
// neighbors-first) heuristic, which keeps backtracking cheap on an open grid graph. Grid graphs
// this size are always Hamiltonian-connected in practice, but a per-attempt step cap plus a
// bounded retry-with-a-new-seed-offset loop guards against the rare pathological case, and would
// become important if this tier table were ever extended to much larger grids (see CLAUDE.md's
// note on Arrow Escape's own generation-time scaling for the same concern in a different game).
// ---------------------------------------------------------------------------

const MAX_STEPS_PER_ATTEMPT = 200000;
const MAX_ATTEMPTS = 20;

function neighborsOf(cell, n) {
  const r = Math.floor(cell / n), c = cell % n;
  const out = [];
  if (r > 0) out.push(cell - n);
  if (r < n - 1) out.push(cell + n);
  if (c > 0) out.push(cell - 1);
  if (c < n - 1) out.push(cell + 1);
  return out;
}

function buildHamiltonianPath(n, rng) {
  const total = n * n;
  const visited = new Uint8Array(total);
  const path = [];
  let steps = 0;

  function unvisitedDegree(cell) {
    let deg = 0;
    for (const nb of neighborsOf(cell, n)) if (!visited[nb]) deg++;
    return deg;
  }

  function dfs(cell) {
    steps++;
    if (steps > MAX_STEPS_PER_ATTEMPT) return false;
    visited[cell] = 1;
    path.push(cell);
    if (path.length === total) return true;

    const candidates = neighborsOf(cell, n).filter((nb) => !visited[nb]);
    shuffle(candidates, rng); // randomize tie order before the stable degree-sort below
    candidates.sort((a, b) => unvisitedDegree(a) - unvisitedDegree(b));

    for (const nb of candidates) {
      if (dfs(nb)) return true;
    }
    visited[cell] = 0;
    path.pop();
    return false;
  }

  const start = rng.nextInt(total);
  return dfs(start) ? path : null;
}

// Cuts the full-coverage path into `pairCount` contiguous segments that partition it exactly.
// Grid size always equals pair count in TIERS above, so `total / pairCount` (= n) is always a
// whole number — every segment starts at exactly length n, then a few small random boundary
// nudges (kept within the >=2-length floor) add visual variety without needing any general
// remainder-distribution logic.
function cutIntoSegments(path, pairCount, rng) {
  const total = path.length;
  const base = total / pairCount;
  const boundaries = [];
  for (let i = 1; i < pairCount; i++) boundaries.push(i * base);

  const jitters = pairCount * 2;
  for (let j = 0; j < jitters; j++) {
    if (boundaries.length === 0) break;
    const bi = rng.nextInt(boundaries.length);
    const delta = rng.nextInt(2) === 0 ? -1 : 1;
    const lo = bi === 0 ? 2 : boundaries[bi - 1] + 2;
    const hi = bi === boundaries.length - 1 ? total - 2 : boundaries[bi + 1] - 2;
    const moved = boundaries[bi] + delta;
    if (moved >= lo && moved <= hi) boundaries[bi] = moved;
  }

  const segments = [];
  let start = 0;
  for (const b of boundaries) {
    segments.push(path.slice(start, b));
    start = b;
  }
  segments.push(path.slice(start));
  return segments;
}

function generateLevel(levelNumber) {
  const tier = tierForLevel(levelNumber);
  const { n, pairCount } = tier;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = new SeededRandom(levelNumber * 1000003 + attempt);
    const path = buildHamiltonianPath(n, rng);
    if (!path) continue;

    const segments = cutIntoSegments(path, pairCount, rng);

    // Sanity assertion (dev-tool only, never shipped): every cell covered exactly once, distinct
    // endpoints per pair — mirrors Shikaku's/Arrow Escape's own "generator constructs a witness
    // solution directly" guarantee, checked here rather than trusted blindly.
    const seen = new Set();
    for (const seg of segments) {
      if (seg.length < 2) throw new Error(`level ${levelNumber}: degenerate segment of length ${seg.length}`);
      for (const cell of seg) {
        if (seen.has(cell)) throw new Error(`level ${levelNumber}: cell ${cell} covered more than once`);
        seen.add(cell);
      }
    }
    if (seen.size !== n * n) throw new Error(`level ${levelNumber}: only ${seen.size}/${n * n} cells covered`);

    const order = shuffle(segments.map((_, i) => i), rng); // shuffle which color gets which segment
    const pairs = order.map((segIdx) => {
      const seg = segments[segIdx];
      const first = seg[0], last = seg[seg.length - 1];
      return [Math.floor(first / n), first % n, Math.floor(last / n), last % n];
    });

    return { n, pairs };
  }

  throw new Error(`level ${levelNumber}: failed to generate a Hamiltonian path after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// CLI — same chunking scheme as arrow-escape/tools/generate-levels.mjs. Zero-padded to 4 digits;
// this exact scheme is duplicated in flow-free/index.html (chunkUrl) and sw.js/the shell's
// index.html (chunk-URL derivation from the manifest); all three must agree on it.
// ---------------------------------------------------------------------------

function pad4(n) {
  return String(n).padStart(4, '0');
}

function chunkFileName(start, end) {
  return `${pad4(start)}-${pad4(end)}.json`;
}

function main() {
  const args = process.argv.slice(2);
  const from = parseInt(args[0] ?? '1', 10);
  const to = parseInt(args[1] ?? '300', 10);
  const outDir = args[2] ?? new URL('../levels', import.meta.url).pathname;
  const chunkSize = parseInt(args[3] ?? '20', 10);

  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  let chunk = {};
  let chunkStart = from;

  for (let levelNumber = from; levelNumber <= to; levelNumber++) {
    const level = generateLevel(levelNumber);
    chunk[levelNumber] = { n: level.n, pairs: level.pairs };

    if (levelNumber % 25 === 0 || levelNumber === to) {
      process.stdout.write(`generated level ${levelNumber}/${to} (${Date.now() - t0}ms elapsed)\n`);
    }

    const isChunkBoundary = (levelNumber - chunkStart + 1) === chunkSize || levelNumber === to;
    if (isChunkBoundary) {
      const fileName = chunkFileName(chunkStart, levelNumber);
      writeFileSync(join(outDir, fileName), JSON.stringify(chunk));
      chunk = {};
      chunkStart = levelNumber + 1;
    }
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ chunkSize, minLevel: from, maxLevel: to }));
  console.log(`wrote levels ${from}-${to} (chunks of ${chunkSize}) to ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
