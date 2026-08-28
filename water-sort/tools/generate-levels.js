// Offline level generator/verifier for Water Sort — NOT loaded by the game itself (index.html
// ships static, pregenerated LEVEL_SETS data; nothing here runs in the browser). Run this with
// plain Node whenever you want to regenerate/expand the level banks:
//
//   node water-sort/tools/generate-levels.js > water-sort/tools/levels.out.js
//
// then copy the printed `LEVEL_SETS = {...}` literal into index.html, replacing the existing one.
// Re-running produces a *different* (still verified-solvable) set each time — puzzles are randomly
// shuffled, not deterministic — so only do this if you actually want to replace the shipped levels
// (e.g. to grow the bank past 60/difficulty), not as a routine step.
//
// Why this exists at all: the game's own puzzle rules (topRunLength-based pours, capacity limits)
// don't make every random shuffle solvable — unlike Sokoban/Lights Out elsewhere in this repo,
// which generate by reversing a sequence of legal moves from a solved state (mathematically
// guaranteed solvable), a sort-puzzle pour isn't its own inverse in general (see the comment on
// canMove/applyMove below), so that trick doesn't apply here. Instead this generates a candidate
// with the standard "deal each color evenly into N tubes, shuffle, add empty tubes" method (the
// same one every Water Sort/Ball Sort clone uses) and only keeps it if an actual solver finds a
// real solution — so every level that ships has been verified reachable, not just structurally
// plausible.

// ---------- Puzzle rules (must exactly match water-sort/index.html's own logic) ----------

function topColor(tube) { return tube.length ? tube[tube.length - 1] : null; }
function topRunLength(tube) {
  if (!tube.length) return 0;
  const c = topColor(tube);
  let n = 0;
  for (let i = tube.length - 1; i >= 0 && tube[i] === c; i--) n++;
  return n;
}
function isSolved(list, conf) {
  return list.every(b => b.length === 0 || (b.length === conf.capacity && b.every(x => x === b[0])));
}
function canMove(tubes, from, to, conf) {
  if (from === to) return false;
  if (!tubes[from].length) return false;
  if (tubes[to].length >= conf.capacity) return false;
  return tubes[to].length === 0 || topColor(tubes[to]) === topColor(tubes[from]);
}
function applyMove(tubes, from, to, conf) {
  const next = tubes.map(t => t.slice());
  const count = Math.min(topRunLength(next[from]), conf.capacity - next[to].length);
  const moved = next[from].splice(next[from].length - count, count);
  next[to].push(...moved);
  return next;
}

// ---------- Solver ----------
// Best-first search (priority = moves-so-far + heuristic) with a transposition table. The
// heuristic (total color-blocks minus color count) isn't proven admissible, so this isn't a
// shortest-path solver — it doesn't need to be, it just needs to reliably find *a* solution when
// one exists. Canonicalizing each state's key by sorting tube contents (not tube position) treats
// "same stacks, different physical tube" states as identical, shrinking the search space a lot
// since tube identity never matters for solvability.
function stateKey(tubes) { return tubes.map(t => t.join(',')).sort().join('|'); }
function totalBlocks(tubes) {
  let n = 0;
  for (const tube of tubes) {
    let prev = null;
    for (const c of tube) { if (c !== prev) n++; prev = c; }
  }
  return n;
}
function heuristic(tubes, conf) { return Math.max(0, totalBlocks(tubes) - conf.colors); }

function solve(start, conf, budget) {
  const seen = new Map([[stateKey(start), 0]]);
  let frontier = [{ tubes: start, g: 0 }];
  let expansions = 0;
  while (frontier.length) {
    let bestIdx = 0, bestF = Infinity;
    for (let i = 0; i < frontier.length; i++) {
      const f = frontier[i].g + heuristic(frontier[i].tubes, conf);
      if (f < bestF) { bestF = f; bestIdx = i; }
    }
    const cur = frontier[bestIdx];
    frontier[bestIdx] = frontier[frontier.length - 1];
    frontier.pop();

    if (isSolved(cur.tubes, conf)) return cur.g;
    expansions++;
    if (expansions > budget) return null;

    const n = cur.tubes.length;
    for (let f = 0; f < n; f++) {
      for (let toI = 0; toI < n; toI++) {
        if (!canMove(cur.tubes, f, toI, conf)) continue;
        const next = applyMove(cur.tubes, f, toI, conf);
        const k = stateKey(next);
        const g2 = cur.g + 1;
        if (!seen.has(k) || seen.get(k) > g2) {
          seen.set(k, g2);
          frontier.push({ tubes: next, g: g2 });
        }
      }
    }
    // Cap frontier growth to keep this fast — drop the worst-scored entries once it gets large.
    if (frontier.length > 4000) {
      frontier.sort((a, b) => (a.g + heuristic(a.tubes, conf)) - (b.g + heuristic(b.tubes, conf)));
      frontier.length = 2500;
    }
  }
  return null;
}

// ---------- Candidate generation ----------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function generateCandidate(conf) {
  const drops = [];
  for (let c = 0; c < conf.colors; c++) for (let i = 0; i < conf.capacity; i++) drops.push(c);
  shuffle(drops);
  const list = [];
  for (let i = 0; i < conf.colors; i++) list.push(drops.slice(i * conf.capacity, (i + 1) * conf.capacity));
  for (let i = 0; i < conf.emptyTubes; i++) list.push([]);
  shuffle(list);
  // An extremely unlucky shuffle can hand back an already-solved board — regenerate rather than
  // ever accepting a pre-solved "puzzle".
  return isSolved(list, conf) ? generateCandidate(conf) : list;
}

// Must stay in sync with water-sort/index.html's own DIFFICULTIES (colors/capacity/emptyTubes) —
// `count`/`minMoves`/`budget` are generator-only knobs with no equivalent in the shipped game.
const DIFFICULTIES = {
  easy:   { colors: 4, capacity: 4, emptyTubes: 2, count: 200, minMoves: 6,  budget: 20000 },
  medium: { colors: 6, capacity: 4, emptyTubes: 2, count: 200, minMoves: 10, budget: 40000 },
  hard:   { colors: 8, capacity: 6, emptyTubes: 2, count: 200, minMoves: 16, budget: 80000 },
};

const out = {};
for (const [name, conf] of Object.entries(DIFFICULTIES)) {
  const levels = [];
  const seenKeys = new Set();
  let attempts = 0;
  const t0 = Date.now();
  let lastLog = t0;
  let lastLevelT = t0;
  while (levels.length < conf.count) {
    attempts++;
    const p = generateCandidate(conf);
    const k = stateKey(p);
    if (seenKeys.has(k)) continue;
    const moves = solve(p, conf, conf.budget);
    if (moves === null || moves < conf.minMoves) continue;
    seenKeys.add(k);
    levels.push(p);
    const now = Date.now();
    console.error(name, 'level', levels.length + '/' + conf.count, 'took', ((now - lastLevelT) / 1000).toFixed(1) + 's');
    lastLevelT = now;
    // Progress visibility — the search can legitimately take minutes per level at hard's capacity,
    // so a summary log only every 10 found levels or 15s of elapsed silence (whichever comes
    // first), on top of the per-level line above, shows overall pace without flooding stderr.
    if (levels.length % 10 === 0 || now - lastLog > 15000) {
      lastLog = now;
      console.error(name, levels.length + '/' + conf.count, 'attempts', attempts, 'elapsed', ((now - t0) / 1000).toFixed(1) + 's');
    }
  }
  console.error(name, 'DONE', levels.length, 'levels, attempts', attempts, 'total time', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  out[name] = levels;
}

// Print a ready-to-paste JS literal (stdout) — verification progress/timing goes to stderr so
// redirecting stdout to a file captures only the data.
console.log('const LEVEL_SETS = ' + JSON.stringify(out) + ';');
