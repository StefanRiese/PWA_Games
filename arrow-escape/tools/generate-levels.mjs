#!/usr/bin/env node
// Offline level pregenerator for Arrow Escape.
//
// Deterministically generates every level from just its level number (`node
// tools/generate-levels.mjs <from> <to>`) and writes a directory of small per-level-range JSON
// chunk files (plus a manifest.json) for the game to `fetch()` on demand — lazy-loading only the
// chunk containing whichever level is actually being played, rather than one large file with
// every level. Matches this repo's "no backend, no build step" rule (still just static files)
// instead of generating puzzles on the fly in the browser.
//
// Level generation works backwards from an empty, "already solved" board: it repeatedly picks a
// clear exit lane and grows a random snake-shaped arrow path inward from it, so every arrow is
// guaranteed removable in the reverse of its construction order — see the "PRNG" section below for
// the custom random number generator this relies on, and `LevelSolver`/`solverSolve` further down
// for the DFS solver used as a final correctness check.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// PRNG — a custom seeded, non-secure random number generator, needed because a level's exact
// layout (mask shape, every arrow's path, orphan dots) must be fully reproducible from just its
// level number, so the same level number always regenerates byte-identical output.
//
// It's a Multiply-with-Carry generator over a 64-bit state, seeded via a Thomas Wang 64-bit
// integer mix. Every arithmetic/bitwise op in that algorithm operates on a native 64-bit
// two's-complement integer, silently wrapping on overflow — so it's implemented here with BigInt
// masked to 64 bits after every op that can overflow, to get that exact wraparound behavior.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xffffffffn;
const POW2_32 = 4294967296;
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
    // "Crank a couple of times to distribute the seed bits a bit further."
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
      // Fast case for powers of two.
      this._nextState();
      return Number(this.state & MASK32) & (max - 1);
    }
    let rnd32, result;
    do {
      this._nextState();
      rnd32 = Number(this.state & MASK32);
      result = rnd32 % max;
    } while (rnd32 - result + max > POW2_32);
    return result;
  }

  nextDouble() {
    return (this.nextInt(1 << 26) * POW2_27_D + this.nextInt(1 << 27)) / POW2_53_D;
  }

  nextBool() {
    return this.nextInt(2) === 0;
  }
}

// ---------------------------------------------------------------------------
// Arrow direction / orphan-dot helpers
// ---------------------------------------------------------------------------

// Matches `ArrowDirection.values` iteration order — some loops depend on it.
const DIRECTIONS = ['up', 'down', 'left', 'right'];

const DELTA = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const TURN_RIGHT = { up: 'right', right: 'down', down: 'left', left: 'up' };
const TURN_LEFT = { up: 'left', left: 'down', down: 'right', right: 'up' };

const delta = (d) => DELTA[d];
const opposite = (d) => OPPOSITE[d];
const turnRight = (d) => TURN_RIGHT[d];
const turnLeft = (d) => TURN_LEFT[d];

// OrphanDotType — a packed numeric type used by the solver; index order matters (up=0, down=1,
// left=2, right=3, neutral=4) since it's stored directly in a typed array.
const OrphanDotType = { up: 0, down: 1, left: 2, right: 3, neutral: 4 };
const dotTypeForDir = (dir) => OrphanDotType[dir];
const dirForDotType = (type) => DIRECTIONS[type] ?? 'up';

// ---------------------------------------------------------------------------
// Sort — a self-contained dual-pivot quicksort (with an insertion-sort cutover for small ranges),
// used instead of the JS engine's own `Array.prototype.sort`.
//
// This matters because `shuffleCandidatesFromCenter`'s comparator calls `rng.nextDouble()` on
// every single invocation — so the exact number and order of comparator calls a sort performs
// directly determines the resulting random sequence, and therefore every level generated after
// that shuffle. A native `Array.sort` is not required by spec to call the comparator any
// particular number of times, and different JS engines (or different versions of the same engine)
// are free to use different sorting algorithms — which would make a level's exact layout dependent
// on which browser generated it. Implementing one fixed, specific algorithm here guarantees the
// same comparator call sequence — and therefore the same generated level for a given level number
// — on every engine, forever.
// ---------------------------------------------------------------------------

const INSERTION_SORT_THRESHOLD = 32;

function deterministicSort(a, compare, left = 0, right = a.length - 1) {
  if (right - left <= INSERTION_SORT_THRESHOLD) {
    insertionSort(a, left, right, compare);
  } else {
    dualPivotQuicksort(a, left, right, compare);
  }
}

function insertionSort(a, left, right, compare) {
  for (let i = left + 1; i <= right; i++) {
    const el = a[i];
    let j = i;
    while (j > left && compare(a[j - 1], el) > 0) {
      a[j] = a[j - 1];
      j--;
    }
    a[j] = el;
  }
}

function dualPivotQuicksort(a, left, right, compare) {
  const sixth = Math.trunc((right - left + 1) / 6);
  const index1 = left + sixth;
  const index5 = right - sixth;
  const index3 = Math.trunc((left + right) / 2);
  const index2 = index3 - sixth;
  const index4 = index3 + sixth;

  let el1 = a[index1], el2 = a[index2], el3 = a[index3], el4 = a[index4], el5 = a[index5];

  if (compare(el1, el2) > 0) { const t = el1; el1 = el2; el2 = t; }
  if (compare(el4, el5) > 0) { const t = el4; el4 = el5; el5 = t; }
  if (compare(el1, el3) > 0) { const t = el1; el1 = el3; el3 = t; }
  if (compare(el2, el3) > 0) { const t = el2; el2 = el3; el3 = t; }
  if (compare(el1, el4) > 0) { const t = el1; el1 = el4; el4 = t; }
  if (compare(el3, el4) > 0) { const t = el3; el3 = el4; el4 = t; }
  if (compare(el2, el5) > 0) { const t = el2; el2 = el5; el5 = t; }
  if (compare(el2, el3) > 0) { const t = el2; el2 = el3; el3 = t; }
  if (compare(el4, el5) > 0) { const t = el4; el4 = el5; el5 = t; }

  const pivot1 = el2, pivot2 = el4;

  a[index1] = el1;
  a[index3] = el3;
  a[index5] = el5;
  a[index2] = a[left];
  a[index4] = a[right];

  let less = left + 1;
  let great = right - 1;

  const pivotsAreEqual = compare(pivot1, pivot2) === 0;
  if (pivotsAreEqual) {
    const pivot = pivot1;
    for (let k = less; k <= great; k++) {
      const ak = a[k];
      const comp = compare(ak, pivot);
      if (comp === 0) continue;
      if (comp < 0) {
        if (k !== less) { a[k] = a[less]; a[less] = ak; }
        less++;
      } else {
        while (true) {
          const c = compare(a[great], pivot);
          if (c > 0) { great--; continue; }
          else if (c < 0) { a[k] = a[less]; a[less++] = a[great]; a[great--] = ak; break; }
          else { a[k] = a[great]; a[great--] = ak; break; }
        }
      }
    }
  } else {
    for (let k = less; k <= great; k++) {
      const ak = a[k];
      const compPivot1 = compare(ak, pivot1);
      if (compPivot1 < 0) {
        if (k !== less) { a[k] = a[less]; a[less] = ak; }
        less++;
      } else {
        const compPivot2 = compare(ak, pivot2);
        if (compPivot2 > 0) {
          while (true) {
            const c = compare(a[great], pivot2);
            if (c > 0) { great--; if (great < k) break; continue; }
            else {
              const c2 = compare(a[great], pivot1);
              if (c2 < 0) { a[k] = a[less]; a[less++] = a[great]; a[great--] = ak; }
              else { a[k] = a[great]; a[great--] = ak; }
              break;
            }
          }
        }
      }
    }
  }

  a[left] = a[less - 1];
  a[less - 1] = pivot1;
  a[right] = a[great + 1];
  a[great + 1] = pivot2;

  deterministicSort(a, compare, left, less - 2);
  deterministicSort(a, compare, great + 2, right);

  if (pivotsAreEqual) return;

  if (less < index1 && great > index5) {
    while (compare(a[less], pivot1) === 0) less++;
    while (compare(a[great], pivot2) === 0) great--;

    for (let k = less; k <= great; k++) {
      const ak = a[k];
      const compPivot1 = compare(ak, pivot1);
      if (compPivot1 === 0) {
        if (k !== less) { a[k] = a[less]; a[less] = ak; }
        less++;
      } else {
        const compPivot2 = compare(ak, pivot2);
        if (compPivot2 === 0) {
          while (true) {
            const c = compare(a[great], pivot2);
            if (c === 0) { great--; if (great < k) break; continue; }
            else {
              const c2 = compare(a[great], pivot1);
              if (c2 < 0) { a[k] = a[less]; a[less++] = a[great]; a[great--] = ak; }
              else { a[k] = a[great]; a[great--] = ak; }
              break;
            }
          }
        }
      }
    }
    deterministicSort(a, compare, less, great);
  } else {
    deterministicSort(a, compare, less, great);
  }
}

// ---------------------------------------------------------------------------
// Mask generator
// ---------------------------------------------------------------------------

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1.0;
}

function fromPredicate(side, predicate) {
  const mask = new Set();
  const s = side;
  for (let r = 0; r < side; r++) {
    const y = (r + 0.5) / s;
    for (let c = 0; c < side; c++) {
      const x = (c + 0.5) / s;
      const absDx = Math.abs(x - 0.5);
      if (predicate(x, y, absDx)) mask.add(`${r},${c}`);
    }
  }
  return clean(mask, side);
}

function clean(mask) {
  if (mask.size === 0) return mask;
  const visited = new Set();
  const regions = [];
  for (const cell of mask) {
    if (visited.has(cell)) continue;
    const region = new Set();
    const stack = [cell];
    while (stack.length) {
      const cur = stack.pop();
      if (!mask.has(cur) || visited.has(cur)) continue;
      visited.add(cur);
      region.add(cur);
      const [r, c] = cur.split(',').map(Number);
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nk = `${r + dr},${c + dc}`;
        if (mask.has(nk) && !visited.has(nk)) stack.push(nk);
      }
    }
    if (region.size > 0) regions.push(region);
  }
  if (regions.length === 0) return mask;
  deterministicSort(regions, (a, b) => b.size - a.size);
  return regions[0];
}

function squareMask(side) {
  const mask = new Set();
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) mask.add(`${r},${c}`);
  return mask;
}

const catMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.58, 0.38, 0.32)) return true;
  if (inEllipse(absDx, y, 0.28, 0.24, 0.14, 0.18)) return true;
  if (y >= 0.14 && y <= 0.38 && absDx >= 0.16 && absDx <= 0.40) {
    const t = (y - 0.14) / 0.24;
    if (absDx <= 0.28 + t * 0.12 && absDx >= 0.28 - t * 0.12) return true;
  }
  return false;
});

const dogMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.48, 0.32, 0.28)) return true;
  if (inEllipse(absDx, y, 0.35, 0.52, 0.13, 0.30)) return true;
  if (inEllipse(absDx, y, 0.0, 0.68, 0.22, 0.20)) return true;
  if (inEllipse(absDx, y, 0.0, 0.30, 0.22, 0.14)) return true;
  return false;
});

const frogMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.62, 0.44, 0.28)) return true;
  if (inEllipse(absDx, y, 0.26, 0.32, 0.17, 0.18)) return true;
  if (inEllipse(absDx, y, 0.0, 0.42, 0.24, 0.14)) return true;
  if (inEllipse(absDx, y, 0.36, 0.82, 0.10, 0.08)) return true;
  return false;
});

const foxMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.46, 0.38, 0.24)) return true;
  if (inEllipse(absDx, y, 0.30, 0.24, 0.14, 0.20)) return true;
  if (y >= 0.12 && y <= 0.40 && absDx >= 0.16 && absDx <= 0.44) {
    const t = (y - 0.12) / 0.28;
    if (absDx <= 0.30 + t * 0.14 && absDx >= 0.30 - t * 0.14) return true;
  }
  if (y >= 0.44 && y <= 0.86) {
    const t = (y - 0.44) / 0.42;
    if (absDx <= (1.0 - t * 0.82) * 0.36) return true;
  }
  return false;
});

const tigerMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.52, 0.40, 0.34)) return true;
  if (inEllipse(absDx, y, 0.30, 0.22, 0.14, 0.14)) return true;
  if (inEllipse(absDx, y, 0.36, 0.60, 0.12, 0.16)) return true;
  if (inEllipse(absDx, y, 0.0, 0.72, 0.24, 0.16)) return true;
  return false;
});

const pandaMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.54, 0.42, 0.36)) return true;
  if (inEllipse(absDx, y, 0.32, 0.22, 0.16, 0.15)) return true;
  if (inEllipse(absDx, y, 0.34, 0.62, 0.12, 0.16)) return true;
  return false;
});

const fishMask = (side) => fromPredicate(side, (x, y) => {
  if (inEllipse(x, y, 0.44, 0.50, 0.32, 0.24)) return true;
  if (x <= 0.44) {
    const t = (0.44 - x) / 0.34;
    if (t <= 1.0 && Math.abs(y - 0.50) <= (1.0 - t * 0.8) * 0.24) return true;
  }
  if (inEllipse(x, y, 0.46, 0.24, 0.16, 0.12) && y <= 0.50) return true;
  if (inEllipse(x, y, 0.46, 0.76, 0.12, 0.10) && y >= 0.50) return true;
  if (x >= 0.66 && x <= 0.90) {
    const t = (x - 0.66) / 0.24;
    const spread = 0.08 + t * 0.28;
    if (Math.abs(y - 0.50) <= spread) {
      if (x > 0.82 && Math.abs(y - 0.50) < (x - 0.82) * 1.5) return false;
      return true;
    }
  }
  return false;
});

const birdMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.52, 0.14, 0.30)) return true;
  if (inEllipse(absDx, y, 0.0, 0.22, 0.10, 0.12)) return true;
  if (y >= 0.10 && y <= 0.22 && absDx <= (y - 0.10) * 0.6) return true;
  if (y >= 0.24 && y <= 0.64) {
    const t = (y - 0.24) / 0.40;
    const wingSpan = 0.12 + Math.sin(t * Math.PI) * 0.36;
    if (absDx <= wingSpan) return true;
  }
  if (y >= 0.72 && y <= 0.92 && absDx <= (0.92 - y) * 0.6 + 0.06) return true;
  return false;
});

const butterflyMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.50, 0.06, 0.38)) return true;
  if (inEllipse(absDx, y, 0.28, 0.34, 0.20, 0.22)) return true;
  if (inEllipse(absDx, y, 0.24, 0.68, 0.16, 0.18)) return true;
  if (inEllipse(absDx, y, 0.12, 0.14, 0.05, 0.05)) return true;
  return false;
});

const guitarMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.72, 0.32, 0.22)) return true;
  if (inEllipse(absDx, y, 0.0, 0.46, 0.24, 0.16)) return true;
  if (absDx <= 0.18 && y >= 0.44 && y <= 0.74) return true;
  if (absDx <= 0.08 && y >= 0.18 && y <= 0.46) return true;
  if (inEllipse(absDx, y, 0.0, 0.12, 0.12, 0.08)) return true;
  return false;
});

const treeMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.0, 0.26, 0.24, 0.18)) return true;
  if (inEllipse(absDx, y, 0.0, 0.46, 0.36, 0.20)) return true;
  if (inEllipse(absDx, y, 0.0, 0.64, 0.44, 0.20)) return true;
  if (absDx <= 0.11 && y >= 0.60 && y <= 0.94) return true;
  return false;
});

const houseMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (y >= 0.12 && y <= 0.46 && absDx <= (y - 0.12) / 0.34 * 0.46) return true;
  if (absDx <= 0.38 && y >= 0.44 && y <= 0.88) return true;
  if (x >= 0.64 && x <= 0.76 && y >= 0.18 && y <= 0.44) return true;
  return false;
});

const crownMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (absDx <= 0.42 && y >= 0.62 && y <= 0.84) return true;
  if (y >= 0.18 && y <= 0.64 && absDx <= (y - 0.18) / 0.46 * 0.16) return true;
  if (y >= 0.28 && y <= 0.64 && Math.abs(absDx - 0.34) <= (y - 0.28) / 0.36 * 0.12) return true;
  if (y >= 0.48 && y <= 0.64 && absDx <= 0.38) return true;
  return false;
});

const heartMask = (side) => fromPredicate(side, (x, y, absDx) => {
  if (inEllipse(absDx, y, 0.22, 0.36, 0.22, 0.22)) return true;
  if (y >= 0.36 && y <= 0.90 && absDx <= 0.44 * (1.0 - (y - 0.36) / 0.54)) return true;
  if (absDx <= 0.22 && y >= 0.24 && y <= 0.50) return true;
  return false;
});

function starMask(side, points) {
  const mask = new Set();
  const s = side;
  const cx = 0.5, cy = 0.5;
  const outerR = 0.46, innerR = 0.20;
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const x = (c + 0.5) / s - cx;
      const y = (r + 0.5) / s - cy;
      const angle = (Math.atan2(y, x) + Math.PI * 2) % (2 * Math.PI);
      const sector = Math.floor(angle / (2 * Math.PI / points));
      const dist = Math.sqrt(x * x + y * y);
      const edgeAngle = angle - sector * (2 * Math.PI / points);
      const t = Math.min(1, Math.max(0, edgeAngle / (2 * Math.PI / points)));
      const radiusAtAngle = t < 0.5
        ? outerR - (outerR - innerR) * (t * 2)
        : innerR + (outerR - innerR) * ((t - 0.5) * 2);
      if (dist <= radiusAtAngle) mask.add(`${r},${c}`);
    }
  }
  return clean(mask, side);
}

const diamondMask = (side) => fromPredicate(side, (x, y, absDx) =>
  (absDx / 0.45) + (Math.abs(y - 0.5) / 0.45) <= 1.0);

const hexagonMask = (side) => fromPredicate(side, (x, y, absDx) => {
  const dy = Math.abs(y - 0.5);
  return dy <= 0.42 && (absDx * 0.866 + dy * 0.5) <= 0.42 && absDx <= 0.44;
});

function blobMask(side, seed) {
  const rng = new SeededRandom(seed);
  const offsets = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6.0) * 2 * Math.PI;
    const dist = 0.16 + rng.nextDouble() * 0.12;
    const r = 0.14 + rng.nextDouble() * 0.08;
    offsets.push([0.5 + Math.cos(angle) * dist, 0.5 + Math.sin(angle) * dist, r]);
  }
  return fromPredicate(side, (x, y) => {
    if (inEllipse(x, y, 0.5, 0.5, 0.30, 0.28)) return true;
    for (const o of offsets) {
      if (inEllipse(x, y, o[0], o[1], o[2], o[2])) return true;
    }
    return false;
  });
}

const circleMask = (side) => fromPredicate(side, (x, y) => {
  const dx = x - 0.5, dy = y - 0.5;
  return dx * dx + dy * dy <= 0.45 * 0.45;
});

const MASK_BY_NAME = {
  cat: catMask, dog: dogMask, frog: frogMask, fox: foxMask, tiger: tigerMask,
  panda: pandaMask, fish: fishMask, bird: birdMask, butterfly: butterflyMask,
  guitar: guitarMask, tree: treeMask, house: houseMask, crown: crownMask,
  heart: heartMask, diamond: diamondMask, hexagon: hexagonMask, circle: circleMask,
};

function shapeByName(name, side, rng) {
  if (name === 'star') return starMask(side, 5);
  if (name === 'blob') return blobMask(side, rng.nextInt(9999));
  const fn = MASK_BY_NAME[name];
  return fn ? fn(side) : squareMask(side);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOSS_LEVEL_EVERY = 5;
const GOD_LEVEL_EVERY = 10;

function levelTypeFor(level) {
  if (level % GOD_LEVEL_EVERY === 0) return 'god';
  if (level % BOSS_LEVEL_EVERY === 0) return 'boss';
  return 'normal';
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function gridSizeForLevel(level) {
  const type = levelTypeFor(level);
  if (type === 'god') {
    const raw = 22 + Math.round((level / 50.0) * 1.2);
    return clampInt(raw, 22, 32);
  }
  if (type === 'boss') {
    const raw = 20 + Math.round((level / 50.0) * 1.2);
    return clampInt(raw, 20, 30);
  }
  if (level <= 10) return 10 + Math.round((level - 1) * 0.44);
  if (level <= 50) return 14 + Math.round((level - 10) * 0.15);
  if (level <= 150) return 20 + Math.round((level - 50) * 0.05);
  if (level <= 300) return 25 + Math.round((level - 150) * 0.03);
  if (level <= 500) return 29 + Math.round((level - 300) * 0.01);
  return 32;
}

// ---------------------------------------------------------------------------
// Solver
//
// Uses a plain deterministic string hash for the visited-state memo below. That memo is purely a
// performance optimization (duplicate-state pruning during backtracking); by construction (see
// growPath below) every generated arrow set is already greedily solvable in final-array order
// without ever needing to backtrack, so the exact hash function used has no effect on the
// solvability verdict or on which levels get generated.
// ---------------------------------------------------------------------------

function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function simulateExit(arrowIdx, gridSize, board, activeOrphans, orphanTypes, arrows, exitVisited, token) {
  const arrow = arrows[arrowIdx];
  let currentDir = arrow.direction;
  const head = arrow.path[0];
  let d = delta(currentDir);
  let nr = head[0] + d[0], nc = head[1] + d[1];
  const consumed = [];

  while (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
    const idx = nr * gridSize + nc;
    if (exitVisited[idx] === token) return null;
    exitVisited[idx] = token;

    if (activeOrphans[idx]) {
      consumed.push(idx);
      const t = orphanTypes[idx];
      if (t === 0) currentDir = 'up';
      else if (t === 1) currentDir = 'down';
      else if (t === 2) currentDir = 'left';
      else if (t === 3) currentDir = 'right';
    } else {
      const val = board[idx];
      if (val !== 0 && val !== arrowIdx + 1) return null;
    }

    d = delta(currentDir);
    nr += d[0];
    nc += d[1];
  }
  return consumed;
}

function solverSolve(level, maxStatesLimit = 5000) {
  const gridSize = level.gridSize;
  const arrows = level.arrows;
  const orphanDots = level.orphanDots;

  const board = new Uint16Array(gridSize * gridSize);
  for (let i = 0; i < arrows.length; i++) {
    for (const pt of arrows[i].path) board[pt[0] * gridSize + pt[1]] = i + 1;
  }

  const orphanTypes = new Uint8Array(gridSize * gridSize);
  const activeOrphans = new Array(gridSize * gridSize).fill(false);
  for (const od of orphanDots) {
    const idx = od.row * gridSize + od.col;
    orphanTypes[idx] = od.type;
    activeOrphans[idx] = true;
  }

  const activeArrows = new Array(arrows.length).fill(true);

  let arrowHash = 0;
  for (let i = 0; i < arrows.length; i++) arrowHash ^= strHash(arrows[i].id);
  let dotHash = orphanDots.length * 997;
  for (const od of orphanDots) dotHash ^= strHash(`${od.row},${od.col}`);

  const visited = new Set();
  const path = [];
  let statesVisited = 0;

  const exitVisited = new Uint32Array(gridSize * gridSize);
  let exitToken = 0;

  function undoGreedy(greedyList) {
    for (let k = greedyList.length - 1; k >= 0; k--) {
      const idx = greedyList[k];
      path.pop();
      for (const pt of arrows[idx].path) board[pt[0] * gridSize + pt[1]] = idx + 1;
      arrowHash ^= strHash(arrows[idx].id);
      activeArrows[idx] = true;
    }
  }

  function dfs(remainingCount) {
    if (remainingCount === 0) return true;
    if (statesVisited > maxStatesLimit) return false;

    const greedyCleared = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < arrows.length; i++) {
        if (!activeArrows[i]) continue;
        exitToken++;
        const consumed = simulateExit(i, gridSize, board, activeOrphans, orphanTypes, arrows, exitVisited, exitToken);
        if (consumed === null) continue;

        let consumesRedirector = false;
        for (const idx of consumed) {
          if (activeOrphans[idx] && orphanTypes[idx] !== OrphanDotType.neutral) {
            consumesRedirector = true;
            break;
          }
        }

        if (!consumesRedirector) {
          activeArrows[i] = false;
          const id = arrows[i].id;
          arrowHash ^= strHash(id);
          for (const pt of arrows[i].path) board[pt[0] * gridSize + pt[1]] = 0;
          for (const idx of consumed) {
            if (activeOrphans[idx]) {
              activeOrphans[idx] = false;
              dotHash ^= strHash(`${Math.floor(idx / gridSize)},${idx % gridSize}`);
            }
          }
          path.push(id);
          greedyCleared.push(i);
          progress = true;
        }
      }
    }

    if (path.length === arrows.length) return true;

    const hash = `${arrowHash}|${dotHash}`;
    if (visited.has(hash)) {
      undoGreedy(greedyCleared);
      return false;
    }
    visited.add(hash);
    statesVisited++;

    for (let i = 0; i < arrows.length; i++) {
      if (!activeArrows[i]) continue;

      exitToken++;
      const consumed = simulateExit(i, gridSize, board, activeOrphans, orphanTypes, arrows, exitVisited, exitToken);
      if (consumed === null) continue;

      activeArrows[i] = false;
      const id = arrows[i].id;
      arrowHash ^= strHash(id);
      for (const pt of arrows[i].path) board[pt[0] * gridSize + pt[1]] = 0;

      const deactivated = [];
      for (const idx of consumed) {
        if (activeOrphans[idx]) {
          activeOrphans[idx] = false;
          deactivated.push(idx);
          dotHash ^= strHash(`${Math.floor(idx / gridSize)},${idx % gridSize}`);
        }
      }

      path.push(id);
      if (dfs(arrows.length - path.length)) return true;

      path.pop();
      for (const idx of deactivated) {
        activeOrphans[idx] = true;
        dotHash ^= strHash(`${Math.floor(idx / gridSize)},${idx % gridSize}`);
      }
      for (const pt of arrows[i].path) board[pt[0] * gridSize + pt[1]] = i + 1;
      arrowHash ^= strHash(id);
      activeArrows[i] = true;
    }

    undoGreedy(greedyCleared);
    return false;
  }

  return dfs(arrows.length) ? path : null;
}

// ---------------------------------------------------------------------------
// Level generator
// ---------------------------------------------------------------------------

function getExitPathPacked(startRow, startCol, exitDir, gridSize) {
  const path = new Set();
  const d = delta(exitDir);
  let nr = startRow + d[0], nc = startCol + d[1];
  while (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
    path.add(nr * 1000 + nc);
    nr += d[0];
    nc += d[1];
  }
  return path;
}

function canExitClean(headRow, headCol, dir, occupiedPacked, gridSize) {
  const d = delta(dir);
  let nr = headRow + d[0], nc = headCol + d[1];
  while (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
    if (occupiedPacked.has(nr * 1000 + nc)) return false;
    nr += d[0];
    nc += d[1];
  }
  return true;
}

function exitCandidates(maskCells, occupiedPacked, gridSize) {
  const out = [];
  for (const [r, c] of maskCells) {
    if (occupiedPacked.has(r * 1000 + c)) continue;
    for (const dir of DIRECTIONS) {
      if (canExitClean(r, c, dir, occupiedPacked, gridSize)) out.push({ row: r, col: c, dir });
    }
  }
  return out;
}

function shuffleCandidatesFromCenter(candidates, gridSize, rng) {
  // The comparator recomputes its jitter on every invocation (not once per element) — sorted via
  // `deterministicSort` rather than the engine's native sort so the exact number/order of
  // comparator calls (and therefore of `rng.nextDouble()` calls) stays fixed regardless of engine.
  // See the "Sort" block above for why this matters.
  const centerRow = gridSize / 2, centerCol = gridSize / 2;
  deterministicSort(candidates, (a, b) => {
    const distA = Math.abs(a.row - centerRow) + Math.abs(a.col - centerCol);
    const distB = Math.abs(b.row - centerRow) + Math.abs(b.col - centerCol);
    const scoreA = distA + (rng.nextDouble() * 2.0 - 1.0);
    const scoreB = distB + (rng.nextDouble() * 2.0 - 1.0);
    return scoreA - scoreB;
  });
}

function packedPick(dirs, cr, cc, occupiedPacked, rng) {
  if (dirs.length === 1) return dirs[0];
  let best = -1;
  const bestDirs = [];
  for (const d of dirs) {
    const nd = delta(d);
    const nr = cr + nd[0], nc = cc + nd[1];
    let score = 0;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (occupiedPacked.has((nr + dr) * 1000 + (nc + dc))) score++;
    }
    if (score > best) {
      best = score;
      bestDirs.length = 0;
      bestDirs.push(d);
    } else if (score === best) {
      bestDirs.push(d);
    }
  }
  return bestDirs[rng.nextInt(bestDirs.length)];
}

function growPath({ startRow, startCol, exitDir, maskPacked, occupiedPacked, targetLen, rng, gridSize, tangleFactor = 0.0 }) {
  const exitPath = getExitPathPacked(startRow, startCol, exitDir, gridSize);
  const path = [[startRow, startCol]];
  const pathPacked = new Set([startRow * 1000 + startCol]);
  let cr = startRow, cc = startCol;
  let growDir = opposite(exitDir);
  let straight = 0;

  const turnBias = 0.65 + tangleFactor * 0.20;
  const maxStraight = tangleFactor >= 0.7 ? 2 : 3;

  for (let step = 1; step < targetLen; step++) {
    const valid = [];
    for (const d of DIRECTIONS) {
      if (d === opposite(growDir)) continue;
      const nd = delta(d);
      const nr = cr + nd[0], nc = cc + nd[1];
      const np = nr * 1000 + nc;
      if (!maskPacked.has(np)) continue;
      if (occupiedPacked.has(np)) continue;
      if (exitPath.has(np)) continue;
      if (pathPacked.has(np)) continue;

      let wouldFormLoop = false;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const adjR = nr + dr, adjC = nc + dc;
        const adjP = adjR * 1000 + adjC;
        if (adjP !== cr * 1000 + cc && pathPacked.has(adjP)) {
          wouldFormLoop = true;
          break;
        }
      }
      if (wouldFormLoop) continue;

      valid.push(d);
    }
    if (valid.length === 0) break;

    if (step === 1 && !valid.includes(growDir)) return null;

    const mustTurn = straight >= maxStraight;
    const turns = valid.filter((d) => d !== growDir);
    const straights = valid.filter((d) => d === growDir);

    let chosen;
    if (step === 1) {
      chosen = growDir;
    } else if (mustTurn && turns.length) {
      chosen = packedPick(turns, cr, cc, occupiedPacked, rng);
    } else if (valid.length === 1) {
      chosen = valid[0];
    } else if (rng.nextDouble() < turnBias && turns.length) {
      chosen = packedPick(turns, cr, cc, occupiedPacked, rng);
    } else if (straights.length) {
      chosen = straights[0];
    } else {
      chosen = packedPick(turns, cr, cc, occupiedPacked, rng);
    }

    straight = chosen === growDir ? straight + 1 : 0;
    const nd = delta(chosen);
    cr += nd[0];
    cc += nd[1];
    path.push([cr, cc]);
    pathPacked.add(cr * 1000 + cc);
    growDir = chosen;
  }

  return path.length >= 2 ? path : null;
}

function hasRedirectorCycle(orphanMap, gridSize) {
  for (const [startPacked, type] of orphanMap) {
    if (type === OrphanDotType.neutral) continue;
    let r = Math.floor(startPacked / 1000);
    let c = startPacked % 1000;
    let dir = dirForDotType(type);

    const visited = new Set([startPacked]);
    let steps = 0;
    const maxSteps = gridSize * gridSize;

    while (true) {
      const d = delta(dir);
      r += d[0];
      c += d[1];
      if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) break;
      steps++;
      if (steps > maxSteps) return true;

      const packed = r * 1000 + c;
      const nextType = orphanMap.get(packed);
      if (nextType !== undefined && nextType !== OrphanDotType.neutral) {
        if (visited.has(packed)) return true;
        visited.add(packed);
        dir = dirForDotType(nextType);
      }
    }
  }
  return false;
}

function arrowHitsOwnBody(arrow, orphanMap, gridSize) {
  let currentDir = arrow.direction;
  const head = arrow.path[0];
  let d = delta(currentDir);
  let nr = head[0] + d[0], nc = head[1] + d[1];
  const visited = new Set();

  while (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
    const keyPacked = nr * 1000 + nc;
    if (visited.has(keyPacked)) return true;
    visited.add(keyPacked);

    for (let i = 1; i < arrow.path.length; i++) {
      if (nr === arrow.path[i][0] && nc === arrow.path[i][1]) return true;
    }

    const dotType = orphanMap.get(keyPacked);
    if (dotType !== undefined && dotType !== OrphanDotType.neutral) currentDir = dirForDotType(dotType);

    d = delta(currentDir);
    nr += d[0];
    nc += d[1];
  }
  return false;
}

function isValidRedirectorMap(orphanMap, gridSize, arrows) {
  if (hasRedirectorCycle(orphanMap, gridSize)) return false;
  for (const a of arrows) {
    if (arrowHitsOwnBody(a, orphanMap, gridSize)) return false;
  }
  return true;
}

function greedySolveWithMap(gridSize, arrows, orphanMap) {
  const board = new Uint16Array(gridSize * gridSize);
  for (let i = 0; i < arrows.length; i++) {
    for (const pt of arrows[i].path) board[pt[0] * gridSize + pt[1]] = i + 1;
  }

  const orphanTypes = new Uint8Array(gridSize * gridSize);
  const orphanActive = new Array(gridSize * gridSize).fill(false);
  for (const [packed, type] of orphanMap) {
    const r = Math.floor(packed / 1000), c = packed % 1000;
    const idx = r * gridSize + c;
    orphanTypes[idx] = type;
    orphanActive[idx] = true;
  }

  const active = new Array(arrows.length).fill(true);
  const order = [];
  let remaining = arrows.length;

  const exitVisited = new Uint16Array(gridSize * gridSize);
  let exitToken = 0;

  function tryExit(ai) {
    exitToken++;
    let dir = arrows[ai].direction;
    const h = arrows[ai].path[0];
    let d = delta(dir);
    let nr = h[0] + d[0], nc = h[1] + d[1];
    const consumed = [];
    while (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
      const idx = nr * gridSize + nc;
      if (exitVisited[idx] === exitToken) return null;
      exitVisited[idx] = exitToken;
      if (orphanActive[idx]) {
        consumed.push(idx);
        const t = orphanTypes[idx];
        if (t === 0) dir = 'up';
        else if (t === 1) dir = 'down';
        else if (t === 2) dir = 'left';
        else if (t === 3) dir = 'right';
      } else {
        const val = board[idx];
        if (val !== 0 && val !== ai + 1) return null;
      }
      d = delta(dir);
      nr += d[0];
      nc += d[1];
    }
    return consumed;
  }

  function clearArrow(idx) {
    active[idx] = false;
    remaining--;
    for (const pt of arrows[idx].path) board[pt[0] * gridSize + pt[1]] = 0;
    order.push(arrows[idx].id);
  }

  let madeProgress = true;
  while (madeProgress && remaining > 0) {
    madeProgress = false;
    for (let i = 0; i < arrows.length; i++) {
      if (!active[i]) continue;
      const c = tryExit(i);
      if (c !== null) {
        for (const f of c) orphanActive[f] = false;
        clearArrow(i);
        madeProgress = true;
      }
    }
  }

  return remaining === 0 ? order : null;
}

function absorbOrphans(arrows, occupied, occupiedPacked, mask, gridSize) {
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    const orphans = [...mask].filter((k) => !occupied.has(k));
    for (const cellKey of orphans) {
      const [r, c] = cellKey.split(',').map(Number);

      for (let i = 0; i < arrows.length; i++) {
        const arrow = arrows[i];
        const tail = arrow.path[arrow.path.length - 1];
        const dist = Math.abs(tail[0] - r) + Math.abs(tail[1] - c);
        if (dist === 1) {
          const ptPacked = r * 1000 + c;
          const exitPath = getExitPathPacked(arrow.path[0][0], arrow.path[0][1], arrow.direction, gridSize);
          if (exitPath.has(ptPacked)) continue;

          let blocksOther = false;
          for (let j = i + 1; j < arrows.length; j++) {
            const otherExit = getExitPathPacked(arrows[j].path[0][0], arrows[j].path[0][1], arrows[j].direction, gridSize);
            if (otherExit.has(ptPacked)) {
              blocksOther = true;
              break;
            }
          }
          if (blocksOther) continue;

          let wouldFormLoop = false;
          if (arrow.path.length >= 3) {
            for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
              const adjR = r + dr, adjC = c + dc;
              if (adjR === tail[0] && adjC === tail[1]) continue;
              for (const pt of arrow.path) {
                if (pt[0] === adjR && pt[1] === adjC) {
                  wouldFormLoop = true;
                  break;
                }
              }
              if (wouldFormLoop) break;
            }
          }
          if (wouldFormLoop) continue;

          arrow.path.push([r, c]);
          occupied.add(cellKey);
          occupiedPacked.add(r * 1000 + c);
          madeProgress = true;
          break;
        }
      }
    }
  }
}

const BOSS_SHAPES = ['cat', 'dog', 'frog', 'fox', 'tiger', 'panda', 'fish', 'bird', 'butterfly', 'guitar', 'tree', 'house', 'crown'];
const GOD_SHAPES = ['heart', 'star', 'diamond', 'hexagon', 'blob', 'circle'];

function shapeFor(type, rng) {
  if (type === 'boss') return BOSS_SHAPES[rng.nextInt(BOSS_SHAPES.length)];
  if (type === 'god') return GOD_SHAPES[rng.nextInt(GOD_SHAPES.length)];
  return 'square';
}

function generateReverse({ levelNumber, gridSize, mask, type, rng, maskShape }) {
  const maskCells = [...mask].map((k) => k.split(',').map(Number));
  const maskPacked = new Set(maskCells.map(([r, c]) => r * 1000 + c));

  const occupied = new Set();
  const occupiedPacked = new Set();
  const reverseArrows = [];

  let baseTangle;
  if (levelNumber <= 14) baseTangle = 0.0;
  else if (levelNumber <= 30) baseTangle = 0.10;
  else if (levelNumber <= 60) baseTangle = 0.30;
  else if (levelNumber <= 150) baseTangle = 0.60;
  else if (levelNumber <= 300) baseTangle = 0.80;
  else baseTangle = 1.0;

  if (type === 'boss') baseTangle = clamp(baseTangle + 0.15, 0.15, 1.0);
  else if (type === 'god') baseTangle = clamp(baseTangle + 0.25, 0.40, 1.0);
  const tangleFactor = baseTangle;

  let veryLongMin = 5 + Math.floor(gridSize / 6);
  let longMin = 3 + Math.floor(gridSize / 10);
  let veryLongMax = Math.max(veryLongMin + 1, clamp(veryLongMin + 4, veryLongMin + 1, mask.size));

  if (maskShape !== 'square') {
    veryLongMin = Math.max(5, Math.round(veryLongMin * 0.8));
    longMin = Math.max(3, Math.round(longMin * 0.8));
    veryLongMax = Math.max(veryLongMin + 1, Math.round(veryLongMax * 0.8));
  }

  function targetLenForTier(tier) {
    if (tier === 'veryLong') return veryLongMin + rng.nextInt(Math.max(1, veryLongMax - veryLongMin + 1));
    if (tier === 'long') return longMin + rng.nextInt(Math.max(1, veryLongMin - longMin));
    return 2 + rng.nextInt(Math.max(1, longMin - 1));
  }

  let veryLongCount = 0, longCount = 0, medCount = 0, failures = 0;
  const maxFailures = 40;

  while (failures < maxFailures && occupiedPacked.size < mask.size) {
    const candidates = exitCandidates(maskCells, occupiedPacked, gridSize);
    if (candidates.length === 0) break;
    shuffleCandidatesFromCenter(candidates, gridSize, rng);

    const total = veryLongCount + longCount + medCount;
    let wantTier;
    if (failures > 10) wantTier = 'medium';
    else if (total === 0) wantTier = 'veryLong';
    else {
      const vlRatio = veryLongCount / total, lRatio = longCount / total;
      if (vlRatio < 0.33) wantTier = 'veryLong';
      else if (lRatio < 0.33) wantTier = 'long';
      else wantTier = 'medium';
    }

    let targetLen = targetLenForTier(wantTier);
    if (failures > 5) targetLen = Math.max(2, targetLen - (failures - 5));

    let bestCand = null, bestPath = null;
    for (const cand of candidates.slice(0, 25)) {
      const path = growPath({
        startRow: cand.row, startCol: cand.col, exitDir: cand.dir,
        maskPacked, occupiedPacked, targetLen, rng, gridSize, tangleFactor,
      });
      if (path !== null && path.length >= 2) {
        bestCand = cand;
        bestPath = path;
        break;
      }
    }

    if (bestCand !== null) {
      reverseArrows.push({
        id: `a_${levelNumber}_${reverseArrows.length}`,
        row: bestPath[0][0],
        col: bestPath[0][1],
        direction: bestCand.dir,
        path: bestPath,
      });
      for (const pt of bestPath) {
        occupied.add(`${pt[0]},${pt[1]}`);
        occupiedPacked.add(pt[0] * 1000 + pt[1]);
      }
      if (bestPath.length >= veryLongMin) veryLongCount++;
      else if (bestPath.length >= longMin) longCount++;
      else medCount++;
      failures = 0;
    } else {
      failures++;
    }
  }

  let madeFillProgress = true;
  while (madeFillProgress && occupiedPacked.size < mask.size) {
    madeFillProgress = false;
    const candidates = exitCandidates(maskCells, occupiedPacked, gridSize);
    if (candidates.length === 0) break;
    shuffleCandidatesFromCenter(candidates, gridSize, rng);

    for (const cand of candidates) {
      const path = growPath({
        startRow: cand.row, startCol: cand.col, exitDir: cand.dir,
        maskPacked, occupiedPacked, targetLen: 2, rng, gridSize, tangleFactor: 0.0,
      });
      if (path !== null && path.length >= 2) {
        reverseArrows.push({
          id: `a_${levelNumber}_${reverseArrows.length}`,
          row: path[0][0],
          col: path[0][1],
          direction: cand.dir,
          path,
        });
        for (const pt of path) {
          occupied.add(`${pt[0]},${pt[1]}`);
          occupiedPacked.add(pt[0] * 1000 + pt[1]);
        }
        madeFillProgress = true;
        break;
      }
    }
  }

  if (occupied.size < mask.size) absorbOrphans(reverseArrows, occupied, occupiedPacked, mask, gridSize);

  const arrows = [];
  for (let i = reverseArrows.length - 1; i >= 0; i--) {
    const a = reverseArrows[i];
    arrows.push({ ...a, id: `a_${levelNumber}_${arrows.length}` });
  }

  if (arrows.length === 0) {
    const mid = Math.floor(gridSize / 2);
    arrows.push({
      id: `a_${levelNumber}_0`,
      row: mid, col: mid, direction: 'right',
      path: [[mid, mid], [mid, Math.max(0, mid - 1)]],
    });
    occupied.add(`${mid},${mid}`);
    occupied.add(`${mid},${Math.max(0, mid - 1)}`);
  }

  const orphanDots = [];
  const emptyCount = mask.size - occupied.size;

  if (emptyCount > 0) {
    const emptyKeysPacked = new Set(
      maskCells.filter(([r, c]) => !occupiedPacked.has(r * 1000 + c)).map(([r, c]) => r * 1000 + c)
    );
    const orphanMap = new Map();

    let colorProb;
    if (levelNumber === 395 || levelNumber === 437) colorProb = 0.0;
    else if (type === 'god') {
      if (levelNumber <= 7) colorProb = 0.50;
      else if (levelNumber <= 20) colorProb = 0.65;
      else if (levelNumber <= 50) colorProb = 0.78;
      else colorProb = 0.88;
    } else if (type === 'boss') {
      if (levelNumber <= 7) colorProb = 0.35;
      else if (levelNumber <= 20) colorProb = 0.50;
      else if (levelNumber <= 50) colorProb = 0.65;
      else colorProb = 0.80;
    } else if (levelNumber === 3) colorProb = 0.60;
    else if (levelNumber <= 14) colorProb = 0.0;
    else if (levelNumber <= 30) colorProb = 0.10;
    else if (levelNumber <= 60) colorProb = 0.20;
    else if (levelNumber <= 150) colorProb = 0.40;
    else if (levelNumber <= 300) colorProb = 0.65;
    else colorProb = 0.80;

    for (let i = 0; i < arrows.length; i++) {
      const arrow = arrows[i];
      let currentDir = arrow.direction;
      const head = arrow.path[0];
      let d = delta(currentDir);
      let nr = head[0] + d[0], nc = head[1] + d[1];
      const visited = new Set();

      while (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
        const keyPacked = nr * 1000 + nc;
        if (visited.has(keyPacked)) break;
        visited.add(keyPacked);

        if (emptyKeysPacked.has(keyPacked)) {
          if (!orphanMap.has(keyPacked)) {
            const shouldColor = rng.nextDouble() < colorProb;
            if (shouldColor) {
              let tooClose = false;
              for (const [pk, val] of orphanMap) {
                if (val === OrphanDotType.neutral) continue;
                const er = Math.floor(pk / 1000), ec = pk % 1000;
                if (Math.abs(er - nr) + Math.abs(ec - nc) < 3) {
                  tooClose = true;
                  break;
                }
              }

              let redirectorChainCount = 0;
              for (const val of orphanMap.values()) if (val !== OrphanDotType.neutral) redirectorChainCount++;

              let maxRedirectorsForLevel;
              if (levelNumber <= 30) maxRedirectorsForLevel = 2;
              else if (levelNumber <= 100) maxRedirectorsForLevel = 4;
              else maxRedirectorsForLevel = 8;

              if (!tooClose && redirectorChainCount < maxRedirectorsForLevel) {
                const turns = rng.nextBool()
                  ? [turnRight(currentDir), turnLeft(currentDir)]
                  : [turnLeft(currentDir), turnRight(currentDir)];

                let assigned = false;
                for (const candDir of turns) {
                  orphanMap.set(keyPacked, dotTypeForDir(candDir));
                  const isSolvable = isValidRedirectorMap(orphanMap, gridSize, arrows) &&
                    greedySolveWithMap(gridSize, arrows, orphanMap) !== null;
                  if (isSolvable) {
                    currentDir = candDir;
                    assigned = true;
                    break;
                  } else {
                    orphanMap.delete(keyPacked);
                  }
                }

                if (!assigned) {
                  orphanMap.set(keyPacked, dotTypeForDir(currentDir));
                  const isSolvable = isValidRedirectorMap(orphanMap, gridSize, arrows) &&
                    greedySolveWithMap(gridSize, arrows, orphanMap) !== null;
                  if (!isSolvable) orphanMap.set(keyPacked, OrphanDotType.neutral);
                }
              } else {
                orphanMap.set(keyPacked, OrphanDotType.neutral);
              }
            } else {
              orphanMap.set(keyPacked, OrphanDotType.neutral);
            }
          } else {
            const dotType = orphanMap.get(keyPacked);
            if (dotType === OrphanDotType.up) currentDir = 'up';
            else if (dotType === OrphanDotType.down) currentDir = 'down';
            else if (dotType === OrphanDotType.left) currentDir = 'left';
            else if (dotType === OrphanDotType.right) currentDir = 'right';
          }
        }

        d = delta(currentDir);
        nr += d[0];
        nc += d[1];
      }
    }

    for (const keyPacked of emptyKeysPacked) {
      if (!orphanMap.has(keyPacked)) orphanMap.set(keyPacked, OrphanDotType.neutral);
    }

    if (!isValidRedirectorMap(orphanMap, gridSize, arrows) ||
        greedySolveWithMap(gridSize, arrows, orphanMap) === null) {
      for (const k of emptyKeysPacked) orphanMap.set(k, OrphanDotType.neutral);
    }

    // `tempLevel` is solved with an *empty* orphanDots list (the carefully-computed `orphanMap` —
    // including any colored redirectors — is never attached to it here), and `orphanDots` (the
    // array actually returned on the level) is populated from `orphanMap` ONLY in the failure
    // branch below, and only with `neutral` dots (not each entry's real redirector type). So a
    // colored redirector dot ships on a level only when the plain arrows-only puzzle fails the
    // solver's sanity check — otherwise every leftover empty cell is simply left blank (no dot at
    // all), no matter what colorProb/redirector logic computed above. In practice this failure
    // branch is essentially never taken (verified across levels 1–500), so colored redirector dots
    // don't currently appear in any generated level. Don't "fix" this without deliberately deciding
    // to change every level's layout — every already-played level would shift underneath players.
    const tempLevel = { levelNumber, gridSize, arrows, maskShape, mask, orphanDots: [] };

    if (solverSolve(tempLevel, 2000) === null) {
      for (const [k] of orphanMap) {
        orphanDots.push({ row: Math.floor(k / 1000), col: k % 1000, type: OrphanDotType.neutral });
      }
    }
  }

  return { levelNumber, gridSize, arrows, maskShape, mask, orphanDots };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function generateLevel(levelNumber) {
  const type = levelTypeFor(levelNumber);
  let gridSize = gridSizeForLevel(levelNumber);
  if (levelNumber === 213) gridSize = 32;
  if (levelNumber === 395) gridSize = 35;
  if (levelNumber === 437) gridSize = 36;

  const seed = levelNumber * 103 + 51;
  const rng = new SeededRandom(seed);

  const maskShape = shapeFor(type, rng);
  const mask = shapeByName(maskShape, gridSize, rng);

  return generateReverse({ levelNumber, gridSize, mask, type, rng, maskShape });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Zero-padded to 4 digits (levels 1-9999) — this exact scheme is duplicated in
// arrow-escape/index.html (chunkUrl) and sw.js/the shell's index.html (chunk-URL derivation from
// the manifest); all three must agree on it, since a chunk's filename is otherwise only
// discoverable by literally listing the output directory, which none of them do.
function pad4(n) {
  return String(n).padStart(4, '0');
}

function chunkFileName(start, end) {
  return `${pad4(start)}-${pad4(end)}.json`;
}

function main() {
  const args = process.argv.slice(2);
  const from = parseInt(args[0] ?? '1', 10);
  const to = parseInt(args[1] ?? '100', 10);
  const outDir = args[2] ?? new URL('../levels', import.meta.url).pathname;
  const chunkSize = parseInt(args[3] ?? '20', 10);

  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  let chunk = {};
  let chunkStart = from;

  for (let n = from; n <= to; n++) {
    const level = generateLevel(n);
    chunk[n] = {
      gridSize: level.gridSize,
      maskShape: level.maskShape,
      mask: [...level.mask],
      arrows: level.arrows.map((a) => ({ direction: a.direction, path: a.path })),
      orphanDots: level.orphanDots.map((d) => [d.row, d.col, d.type]),
    };
    if (n % 25 === 0 || n === to) {
      process.stdout.write(`generated level ${n}/${to} (${Date.now() - t0}ms elapsed)\n`);
    }

    const isChunkBoundary = (n - chunkStart + 1) === chunkSize || n === to;
    if (isChunkBoundary) {
      const fileName = chunkFileName(chunkStart, n);
      writeFileSync(join(outDir, fileName), JSON.stringify(chunk));
      chunk = {};
      chunkStart = n + 1;
    }
  }

  // A tiny manifest instead of a hardcoded level count anywhere else — the game and the Service
  // Worker both fetch this once to learn chunkSize/minLevel/maxLevel and compute the rest of the
  // chunk filenames themselves via the same pad4()/chunkFileName() scheme.
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ chunkSize, minLevel: from, maxLevel: to }));
  console.log(`wrote levels ${from}-${to} (chunks of ${chunkSize}) to ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { generateLevel, SeededRandom };
