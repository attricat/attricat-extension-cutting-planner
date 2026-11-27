// One-dimensional cutting: pieces cut across bars and profiles on a saw.
//
// Lengths are millimetres. Internally they are integers in a unit chosen so
// that every length, the kerf and the trim are whole (tenths of a millimetre
// at worst), scaled down by their common divisor to keep the subset-sum
// tables small.
//
// Kerf model: each piece takes its length plus one kerf, and a bar holds
// `usable + kerf`, so the last cut may run off the end of the bar when what
// is left is shorter than the kerf.

import { createRandom, shuffle } from './random.js';
import { SOLVER_VERSION } from './version.js';

export interface BarPiece {
  /** Caller's key, e.g. an order line; every cut refers back to it. */
  id: string;
  length: number;
  quantity: number;
}

export interface BarStock {
  /** Caller's key, e.g. a stock item or a remnant. */
  id: string;
  length: number;
  /** Bars available; null when the supply is not limited. */
  available: number | null;
  /** A usable remnant rather than a full bar: no start trim, offered first. */
  remnant: boolean;
}

export interface SawRules {
  /** Width of one saw cut. */
  kerf: number;
  /** Cut from the start of each full bar (not of a remnant). */
  startTrim: number;
  /** Shortest offcut kept as a remnant; 0 keeps none. */
  minRemnant: number;
}

export interface BarProblem {
  pieces: BarPiece[];
  stock: BarStock[];
  rules: SawRules;
  /** Use remnants before full bars, smallest first. */
  remnantsFirst: boolean;
  seed: number;
  /** Number of randomised constructions tried; the default suits a browser. */
  effort?: number;
}

export interface BarCut {
  pieceId: string;
  /** Distance from the start of the bar to the start of the piece. */
  offset: number;
  length: number;
}

export type OffcutKind = 'remnant' | 'scrap' | 'none';

export interface BarLayout {
  stockId: string;
  stockLength: number;
  remnantStock: boolean;
  /** Identical bars are listed once with their count. */
  count: number;
  cuts: BarCut[];
  trim: number;
  kerf: number;
  offcut: number;
  offcutKind: OffcutKind;
}

export interface Unplaced {
  pieceId: string;
  quantity: number;
  reason: 'too-long' | 'no-stock';
}

export interface BarScore {
  bars: number;
  stockLength: number;
  partsLength: number;
  kerfLength: number;
  trimLength: number;
  remnantLength: number;
  remnantCount: number;
  scrapLength: number;
  /** Share of the stock length that became parts, 0–1. */
  utilisation: number;
  piecesPlaced: number;
}

export interface BarPlan {
  solverVersion: string;
  seed: number;
  layouts: BarLayout[];
  unplaced: Unplaced[];
  score: BarScore;
  /** True when the plan provably uses the fewest bars (one stock length). */
  optimal: boolean;
}

interface Item {
  piece: number;
  /** Scaled piece length plus kerf. */
  weight: number;
}

interface OpenBar {
  stock: number;
  capacity: number;
  used: number;
  items: Item[];
}

interface Prepared {
  problem: BarProblem;
  unit: number;
  kerf: number;
  startTrim: number;
  /** Scaled length plus kerf per piece. */
  weights: number[];
  /** Scaled capacity (usable length plus kerf) per stock entry. */
  capacities: number[];
  items: Item[];
  unplaced: Unplaced[];
}

const DEFAULT_EFFORT = 24;

export function solveBars(problem: BarProblem): BarPlan {
  validate(problem);
  const prepared = prepare(problem);
  const random = createRandom(problem.seed);
  const effort = Math.max(1, Math.floor(problem.effort ?? DEFAULT_EFFORT));

  let best: OpenBar[] | null = null;
  let bestScore: Comparable | null = null;
  const consider = (bars: OpenBar[] | null) => {
    if (!bars) return;
    const score = comparable(prepared, bars);
    if (!bestScore || better(score, bestScore)) {
      best = bars;
      bestScore = score;
    }
  };

  const decreasing = [...prepared.items].sort((a, b) => b.weight - a.weight || a.piece - b.piece);
  consider(firstFitDecreasing(prepared, decreasing));
  consider(fillBars(prepared, null));
  // Never worse than cutting in order, even when stock runs short.
  consider(nextFit(prepared));
  const bound = lowerBound(prepared);
  const done = () => bound !== null && bestScore !== null && (bestScore as Comparable).unplaced === 0 && (bestScore as Comparable).bars === bound;
  for (let round = 1; round < effort && !done(); round++) {
    consider(fillBars(prepared, random));
    consider(firstFitDecreasing(prepared, perturb(decreasing, random)));
  }
  // Repeated bin completion: dissolve the emptiest bar with a few others and
  // refill their pieces; keep the result when it is no worse, so free length
  // drifts into one bar until that bar can be emptied.
  for (let round = 0; round < effort * 20 && !done() && best !== null; round++) {
    const current: OpenBar[] = best;
    if (current.length < 2) break;
    const candidate = dissolve(prepared, current, random);
    const score = comparable(prepared, candidate);
    if (!better(bestScore!, score)) {
      best = candidate;
      bestScore = score;
    }
  }

  const bars = best ?? [];
  const plan = toPlan(prepared, bars);
  plan.optimal = bound !== null && plan.unplaced.length === 0 && plan.score.bars === bound;
  return plan;
}

/** Cutting the lines in order, each piece on the current bar or a new one. */
export function baselineBars(problem: BarProblem): BarPlan {
  validate(problem);
  const prepared = prepare(problem);
  return toPlan(prepared, nextFit(prepared));
}

function nextFit(prepared: Prepared): OpenBar[] {
  const { problem } = prepared;
  const available = availability(problem);
  const bars: OpenBar[] = [];
  let current: OpenBar | null = null;
  for (const item of prepared.items) {
    if (current && current.used + item.weight <= current.capacity) {
      current.used += item.weight;
      current.items.push(item);
      continue;
    }
    const stock = pickStockForItem(prepared, available, item.weight);
    if (stock === null) continue; // counted as unplaced by toPlan
    take(available, stock);
    current = { stock, capacity: prepared.capacities[stock]!, used: item.weight, items: [item] };
    bars.push(current);
  }
  return bars;
}

function validate(problem: BarProblem): void {
  const { kerf, startTrim, minRemnant } = problem.rules;
  for (const value of [kerf, startTrim, minRemnant]) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Saw rules must be non-negative numbers');
  }
  for (const piece of problem.pieces) {
    if (!(piece.length > 0) || !Number.isInteger(piece.quantity) || piece.quantity < 0) {
      throw new RangeError(`Invalid piece ${piece.id}`);
    }
  }
  for (const stock of problem.stock) {
    if (!(stock.length > 0) || (stock.available !== null && (!Number.isInteger(stock.available) || stock.available < 0))) {
      throw new RangeError(`Invalid stock ${stock.id}`);
    }
  }
}

function prepare(problem: BarProblem): Prepared {
  const { rules } = problem;
  const raw = [
    rules.kerf,
    rules.startTrim,
    ...problem.pieces.map((piece) => piece.length),
    ...problem.stock.map((stock) => stock.length),
  ].map((value) => Math.round(value * 10));
  const divisor = raw.reduce((acc, value) => gcd(acc, value), 0) || 1;
  // Millimetres per internal unit.
  const unit = divisor / 10;
  const scale = (value: number) => Math.round((value * 10) / divisor);

  const kerf = scale(rules.kerf);
  const startTrim = scale(rules.startTrim);
  const weights = problem.pieces.map((piece) => scale(piece.length) + kerf);
  const capacities = problem.stock.map(
    (stock) => scale(stock.length) - (stock.remnant ? 0 : startTrim) + kerf,
  );
  const largest = Math.max(0, ...capacities);
  const items: Item[] = [];
  const unplaced: Unplaced[] = [];
  problem.pieces.forEach((piece, index) => {
    if (piece.quantity === 0) return;
    if (weights[index]! > largest) {
      unplaced.push({ pieceId: piece.id, quantity: piece.quantity, reason: 'too-long' });
      return;
    }
    for (let n = 0; n < piece.quantity; n++) items.push({ piece: index, weight: weights[index]! });
  });
  return { problem, unit, kerf, startTrim, weights, capacities, items, unplaced };
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}

function availability(problem: BarProblem): number[] {
  return problem.stock.map((stock) => (stock.available === null ? Number.POSITIVE_INFINITY : stock.available));
}

function take(available: number[], stock: number): void {
  available[stock] = available[stock]! - 1;
}

/**
 * The stock to open for a piece. Remnants first (smallest that fits) when
 * asked; otherwise, and once no remnant fits, the longest full bar for the
 * heuristics (they shrink it afterwards) or the longest for the baseline.
 */
function pickStockForItem(
  prepared: Prepared,
  available: number[],
  weight: number,
): number | null {
  const { problem, capacities } = prepared;
  const fits = (index: number) => available[index]! > 0 && capacities[index]! >= weight;
  if (problem.remnantsFirst) {
    let remnant: number | null = null;
    problem.stock.forEach((stock, index) => {
      if (!stock.remnant || !fits(index)) return;
      if (remnant === null || capacities[index]! < capacities[remnant]!) remnant = index;
    });
    if (remnant !== null) return remnant;
  }
  let chosen: number | null = null;
  problem.stock.forEach((stock, index) => {
    if (problem.remnantsFirst && stock.remnant) return;
    if (!fits(index)) return;
    if (chosen === null || capacities[index]! > capacities[chosen]!) chosen = index;
  });
  return chosen;
}

function firstFitDecreasing(prepared: Prepared, order: Item[]): OpenBar[] {
  const available = availability(prepared.problem);
  const bars: OpenBar[] = [];
  for (const item of order) {
    const open = bars.find((bar) => bar.used + item.weight <= bar.capacity);
    if (open) {
      open.used += item.weight;
      open.items.push(item);
      continue;
    }
    const stock = pickStockForItem(prepared, available, item.weight);
    if (stock === null) continue; // counted as unplaced by toPlan
    take(available, stock);
    bars.push({ stock, capacity: prepared.capacities[stock]!, used: item.weight, items: [item] });
  }
  shrink(prepared, bars, available);
  return bars;
}

/** Moves each bar to the shortest available stock of its kind that still holds it. */
function shrink(prepared: Prepared, bars: OpenBar[], available: number[]): void {
  const { problem, capacities } = prepared;
  const ordered = [...bars].sort((a, b) => b.used - a.used);
  for (const bar of ordered) {
    const kind = problem.stock[bar.stock]!.remnant;
    let target = bar.stock;
    problem.stock.forEach((stock, index) => {
      if (problem.remnantsFirst && stock.remnant !== kind) return;
      if (available[index]! <= 0 || capacities[index]! < bar.used) return;
      if (capacities[index]! < capacities[target]!) target = index;
    });
    if (target !== bar.stock) {
      available[bar.stock] = available[bar.stock]! + 1;
      take(available, target);
      bar.stock = target;
      bar.capacity = capacities[target]!;
    }
  }
}

/**
 * Fills one bar at a time with the subset of the remaining pieces that leaves
 * the least unused length (bounded subset sum), choosing for each bar the
 * stock that it fills best. With a generator, ties and near-ties are broken
 * at random so repeated runs explore different plans.
 */
function fillBars(
  prepared: Prepared,
  random: (() => number) | null,
  pool: Item[] = prepared.items,
  available: number[] = availability(prepared.problem),
): OpenBar[] {
  const { problem, capacities, weights } = prepared;
  const remaining = new Map<number, number>();
  for (const item of pool) remaining.set(item.piece, (remaining.get(item.piece) ?? 0) + 1);
  const bars: OpenBar[] = [];

  while (remaining.size > 0) {
    const types = [...remaining.keys()];
    if (random) shuffle(types, random);
    else types.sort((a, b) => weights[b]! - weights[a]! || a - b);
    const smallest = Math.min(...types.map((type) => weights[type]!));

    let candidates = problem.stock
      .map((_, index) => index)
      .filter((index) => available[index]! > 0 && capacities[index]! >= smallest);
    if (problem.remnantsFirst) {
      const remnants = candidates.filter((index) => problem.stock[index]!.remnant);
      if (remnants.length > 0) candidates = [remnants.reduce((a, b) => (capacities[a]! <= capacities[b]! ? a : b))];
    }
    if (candidates.length === 0) break;

    let chosen: { stock: number; picked: number[]; fill: number; ratio: number } | null = null;
    for (const stock of candidates) {
      const picked = bestSubset(types, remaining, weights, capacities[stock]!);
      const fill = picked.reduce((sum, type) => sum + weights[type]!, 0);
      const ratio = fill / capacities[stock]!;
      const jitter = random ? (random() - 0.5) * 0.01 : 0;
      if (!chosen || ratio + jitter > chosen.ratio) chosen = { stock, picked, fill, ratio: ratio + jitter };
    }
    if (!chosen || chosen.picked.length === 0) break;

    take(available, chosen.stock);
    const items = chosen.picked.map((type) => ({ piece: type, weight: weights[type]! }));
    bars.push({ stock: chosen.stock, capacity: capacities[chosen.stock]!, used: chosen.fill, items });
    for (const type of chosen.picked) {
      const left = remaining.get(type)! - 1;
      if (left === 0) remaining.delete(type);
      else remaining.set(type, left);
    }
  }
  shrink(prepared, bars, available);
  return bars;
}

/** The multiset of piece types with the largest total weight not above the capacity. */
function bestSubset(types: number[], remaining: Map<number, number>, weights: number[], capacity: number): number[] {
  // Binary splitting turns each bounded type into 0/1 bundles.
  const bundleType: number[] = [];
  const bundleCount: number[] = [];
  for (const type of types) {
    const weight = weights[type]!;
    if (weight > capacity) continue;
    let count = Math.min(remaining.get(type)!, Math.floor(capacity / weight));
    for (let size = 1; count > 0; size *= 2) {
      const n = Math.min(size, count);
      bundleType.push(type);
      bundleCount.push(n);
      count -= n;
    }
  }
  // from[s]: the bundle that first reached total s (-1 unreached, -2 for 0).
  const from = new Int32Array(capacity + 1).fill(-1);
  from[0] = -2;
  let best = 0;
  for (let b = 0; b < bundleType.length && best < capacity; b++) {
    const w = weights[bundleType[b]!]! * bundleCount[b]!;
    for (let s = capacity; s >= w; s--) {
      if (from[s] === -1 && from[s - w] !== -1) {
        from[s] = b;
        if (s > best) best = s;
      }
    }
  }
  const picked: number[] = [];
  for (let s = best; s > 0; ) {
    const b = from[s]!;
    for (let n = 0; n < bundleCount[b]!; n++) picked.push(bundleType[b]!);
    s -= weights[bundleType[b]!]! * bundleCount[b]!;
  }
  return picked;
}

/** Refills the emptiest bar and two to four others; the rest stay as they are. */
function dissolve(prepared: Prepared, bars: OpenBar[], random: () => number): OpenBar[] {
  let emptiest = 0;
  bars.forEach((bar, index) => {
    if (bar.used / bar.capacity < bars[emptiest]!.used / bars[emptiest]!.capacity) emptiest = index;
  });
  const chosen = new Set([emptiest]);
  const extra = Math.min(bars.length - 1, 2 + Math.floor(random() * 3));
  while (chosen.size < extra + 1) chosen.add(Math.floor(random() * bars.length));
  const kept = bars.filter((_, index) => !chosen.has(index));
  const available = availability(prepared.problem);
  for (const bar of kept) take(available, bar.stock);
  const pool = bars.filter((_, index) => chosen.has(index)).flatMap((bar) => bar.items);
  return [...kept, ...fillBars(prepared, random, pool, available)];
}

function perturb(order: Item[], random: () => number): Item[] {
  // Swap neighbours now and then so FFD sees a slightly different order.
  const copy = [...order];
  for (let i = 0; i + 1 < copy.length; i++) {
    if (random() < 0.15) [copy[i], copy[i + 1]] = [copy[i + 1]!, copy[i]!];
  }
  return copy;
}

/**
 * Fewest bars possible when every bar has the same length (Martello and
 * Toth's L2 bound), or null when stock lengths differ.
 */
function lowerBound(prepared: Prepared): number | null {
  const capacities = new Set(prepared.capacities);
  if (capacities.size !== 1 || prepared.items.length === 0) return null;
  const [capacity] = [...capacities] as [number];
  const weights = prepared.items.map((item) => item.weight);
  let bound = Math.ceil(weights.reduce((sum, w) => sum + w, 0) / capacity);
  const alphas = new Set([0, ...weights.filter((w) => w <= capacity / 2)]);
  for (const alpha of alphas) {
    let big = 0; // pieces that no piece of at least alpha can join
    let medium = 0;
    let mediumSum = 0;
    let smallSum = 0;
    for (const w of weights) {
      if (w > capacity - alpha) big++;
      else if (w > capacity / 2) {
        medium++;
        mediumSum += w;
      } else if (w >= alpha) smallSum += w;
    }
    const spill = Math.max(0, Math.ceil((smallSum - (medium * capacity - mediumSum)) / capacity));
    bound = Math.max(bound, big + medium + spill);
  }
  return bound;
}

interface Comparable {
  unplaced: number;
  stockLength: number;
  scrap: number;
  remnants: number;
  bars: number;
  /** Sum of squared fill ratios: higher means free length is concentrated. */
  concentration: number;
}

function comparable(prepared: Prepared, bars: OpenBar[]): Comparable {
  const placed = bars.reduce((sum, bar) => sum + bar.items.length, 0);
  let stockLength = 0;
  let scrap = 0;
  let remnants = 0;
  for (const bar of bars) {
    const layout = measure(prepared, bar);
    stockLength += layout.stockLength;
    if (layout.offcutKind === 'remnant') remnants++;
    else scrap += layout.offcut;
  }
  const concentration = bars.reduce((sum, bar) => sum + (bar.used / bar.capacity) ** 2, 0);
  return { unplaced: prepared.items.length - placed, stockLength, scrap, remnants, bars: bars.length, concentration };
}

function better(a: Comparable, b: Comparable): boolean {
  if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
  if (a.stockLength !== b.stockLength) return a.stockLength < b.stockLength;
  if (a.scrap !== b.scrap) return a.scrap < b.scrap;
  if (a.remnants !== b.remnants) return a.remnants < b.remnants;
  if (a.bars !== b.bars) return a.bars < b.bars;
  return a.concentration > b.concentration + 1e-12;
}

/** One bar's layout in millimetres. */
function measure(prepared: Prepared, bar: OpenBar): Omit<BarLayout, 'count'> {
  const { problem, unit, kerf: kerfUnits } = prepared;
  const stock = problem.stock[bar.stock]!;
  const trim = stock.remnant ? 0 : prepared.startTrim;
  const items = [...bar.items].sort((a, b) => b.weight - a.weight || a.piece - b.piece);
  const cuts: BarCut[] = [];
  let offset = trim;
  let parts = 0;
  for (const item of items) {
    const length = item.weight - kerfUnits;
    cuts.push({ pieceId: problem.pieces[item.piece]!.id, offset: offset * unit, length: problem.pieces[item.piece]!.length });
    offset += length + kerfUnits;
    parts += length;
  }
  const stockUnits = Math.round(stock.length / unit);
  const afterParts = stockUnits - trim - parts;
  const kerf = Math.min(items.length * kerfUnits, afterParts);
  const offcut = afterParts - kerf;
  const minRemnant = problem.rules.minRemnant;
  const offcutMm = round(offcut * unit);
  const offcutKind: OffcutKind =
    offcut <= 0 ? 'none' : minRemnant > 0 && offcutMm >= minRemnant ? 'remnant' : 'scrap';
  return {
    stockId: stock.id,
    stockLength: stock.length,
    remnantStock: stock.remnant,
    cuts: cuts.map((cut) => ({ ...cut, offset: round(cut.offset) })),
    trim: round(trim * unit),
    kerf: round(kerf * unit),
    offcut: Math.max(0, offcutMm),
    offcutKind,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toPlan(prepared: Prepared, bars: OpenBar[]): BarPlan {
  const { problem } = prepared;
  const unplaced = prepared.unplaced.map((entry) => ({ ...entry }));
  const placedPerPiece = new Map<number, number>();
  for (const bar of bars) for (const item of bar.items) placedPerPiece.set(item.piece, (placedPerPiece.get(item.piece) ?? 0) + 1);
  const wanted = new Map<number, number>();
  for (const item of prepared.items) wanted.set(item.piece, (wanted.get(item.piece) ?? 0) + 1);
  for (const [piece, count] of wanted) {
    const missing = count - (placedPerPiece.get(piece) ?? 0);
    if (missing > 0) unplaced.push({ pieceId: problem.pieces[piece]!.id, quantity: missing, reason: 'no-stock' });
  }

  const groups = new Map<string, BarLayout>();
  for (const bar of bars) {
    const layout = measure(prepared, bar);
    const key = `${layout.stockId}\u0000${layout.cuts.map((cut) => `${cut.pieceId}\u0001${cut.length}`).join('\u0000')}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { ...layout, count: 1 });
  }
  // Remnant bars first, then by how often a layout repeats: the cutting order.
  const layouts = [...groups.values()];
  layouts.sort((a, b) => Number(b.remnantStock) - Number(a.remnantStock) || b.count - a.count || a.offcut - b.offcut);
  return { solverVersion: SOLVER_VERSION, seed: problem.seed, layouts, unplaced, score: scoreLayouts(layouts), optimal: false };
}

export function scoreLayouts(layouts: BarLayout[]): BarScore {
  const score: BarScore = {
    bars: 0,
    stockLength: 0,
    partsLength: 0,
    kerfLength: 0,
    trimLength: 0,
    remnantLength: 0,
    remnantCount: 0,
    scrapLength: 0,
    utilisation: 0,
    piecesPlaced: 0,
  };
  for (const layout of layouts) {
    const n = layout.count;
    score.bars += n;
    score.stockLength += layout.stockLength * n;
    score.partsLength += layout.cuts.reduce((sum, cut) => sum + cut.length, 0) * n;
    score.piecesPlaced += layout.cuts.length * n;
    score.kerfLength += layout.kerf * n;
    score.trimLength += layout.trim * n;
    if (layout.offcutKind === 'remnant') {
      score.remnantLength += layout.offcut * n;
      score.remnantCount += n;
    } else score.scrapLength += layout.offcut * n;
  }
  for (const key of ['stockLength', 'partsLength', 'kerfLength', 'trimLength', 'remnantLength', 'scrapLength'] as const) {
    score[key] = round(score[key]);
  }
  score.utilisation = score.stockLength > 0 ? score.partsLength / score.stockLength : 0;
  return score;
}
