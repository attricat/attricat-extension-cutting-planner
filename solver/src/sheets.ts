// Two-dimensional cutting: rectangular parts from sheets.
//
// Coordinates are millimetres with x along the sheet's length and y along
// its width; a part's `length` lies along x and its `width` along y unless it
// is rotated.
//
// Two machines' rules:
//
// - Guillotine (a shear): every cut runs straight across the piece being cut.
//   Plans are staged strip packings: first-stage cuts across the sheet
//   (x = const) make strips, second-stage cuts (y = const) split a strip into
//   parts, and a third-stage trim shortens a part that is shallower than its
//   strip. Kerf separates strips and parts. The edge trim squares the two
//   start edges (x = 0 and y = 0) of a full sheet. The result carries the cut
//   order the operator follows.
// - Free (laser, plasma): MaxRects placement, every part kept `spacing` apart
//   (at least the kerf) and `edgeTrim` from every sheet edge.
//
// Both fill one sheet at a time with the stock that it fills best, from
// several part orderings, and keep the best plan; both are deterministic for
// a seed.

import { createRandom, shuffle } from './random.js';
import { SOLVER_VERSION } from './version.js';

export interface RectPiece {
  id: string;
  /** Along the sheet's length (x). */
  length: number;
  /** Along the sheet's width (y). */
  width: number;
  quantity: number;
  /** Whether the part may be turned 90°. */
  rotate: boolean;
}

export interface SheetStock {
  id: string;
  length: number;
  width: number;
  available: number | null;
  /** A usable remnant: offered first, and a guillotine needs no edge trim on it. */
  remnant: boolean;
}

export interface SheetRules {
  /** `guillotine` for a shear, `free` for a laser or plasma cutter. */
  mode: 'guillotine' | 'free';
  kerf: number;
  /** Free mode: least distance between parts (the kerf if larger). */
  spacing: number;
  edgeTrim: number;
  /** Shortest side of an offcut kept as a remnant; 0 keeps none. */
  minRemnant: number;
}

export interface SheetProblem {
  pieces: RectPiece[];
  stock: SheetStock[];
  rules: SheetRules;
  remnantsFirst: boolean;
  seed: number;
  effort?: number;
}

export interface Placement {
  pieceId: string;
  x: number;
  y: number;
  /** Extent along x and y as placed (swapped when rotated). */
  length: number;
  width: number;
  rotated: boolean;
}

export interface Rect {
  x: number;
  y: number;
  length: number;
  width: number;
}

/** A guillotine cut: a straight line, numbered in cutting order, with its stage. */
export interface Cut {
  order: number;
  stage: 0 | 1 | 2 | 3;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SheetLayout {
  stockId: string;
  sheetLength: number;
  sheetWidth: number;
  remnantStock: boolean;
  count: number;
  placements: Placement[];
  /** Guillotine plans only. */
  cuts: Cut[];
  remnants: Rect[];
  /** The trimmed margin: guillotine start edges, or every edge in free mode. */
  edgeTrim: number;
  partsArea: number;
  remnantArea: number;
  scrapArea: number;
}

export interface SheetUnplaced {
  pieceId: string;
  quantity: number;
  reason: 'too-large' | 'no-stock';
}

export interface SheetScore {
  sheets: number;
  stockArea: number;
  partsArea: number;
  remnantArea: number;
  remnantCount: number;
  scrapArea: number;
  utilisation: number;
  piecesPlaced: number;
}

export interface SheetPlan {
  solverVersion: string;
  seed: number;
  layouts: SheetLayout[];
  unplaced: SheetUnplaced[];
  score: SheetScore;
  optimal: boolean;
}

const EPS = 1e-6;
const DEFAULT_EFFORT = 12;

interface Item {
  piece: number;
  length: number;
  width: number;
  rotate: boolean;
}

/** One sheet as packed, before it is measured. */
interface Packed {
  stock: number;
  placements: { item: Item; x: number; y: number; length: number; width: number; rotated: boolean }[];
  cuts: Cut[];
  remnants: Rect[];
}

type Ordering = (items: Item[], random: () => number) => Item[];

const area = (item: Item) => item.length * item.width;
const orderings: Ordering[] = [
  (items) => [...items].sort((a, b) => area(b) - area(a) || a.piece - b.piece),
  (items) => [...items].sort((a, b) => Math.max(b.length, b.width) - Math.max(a.length, a.width) || area(b) - area(a) || a.piece - b.piece),
  (items) => [...items].sort((a, b) => Math.min(b.length, b.width) - Math.min(a.length, a.width) || area(b) - area(a) || a.piece - b.piece),
  (items) => [...items].sort((a, b) => b.length - a.length || b.width - a.width || a.piece - b.piece),
  (items) => [...items].sort((a, b) => b.width - a.width || b.length - a.length || a.piece - b.piece),
];

function validate(problem: SheetProblem): void {
  const { kerf, spacing, edgeTrim, minRemnant } = problem.rules;
  for (const value of [kerf, spacing, edgeTrim, minRemnant]) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Sheet rules must be non-negative numbers');
  }
  for (const piece of problem.pieces) {
    if (!(piece.length > 0 && piece.width > 0) || !Number.isInteger(piece.quantity) || piece.quantity < 0) {
      throw new RangeError(`Invalid piece ${piece.id}`);
    }
  }
  for (const stock of problem.stock) {
    if (!(stock.length > 0 && stock.width > 0) || (stock.available !== null && (!Number.isInteger(stock.available) || stock.available < 0))) {
      throw new RangeError(`Invalid stock ${stock.id}`);
    }
  }
}

/** Usable region of a sheet: offset and size, and the gap kept between parts. */
function region(problem: SheetProblem, stock: SheetStock) {
  const { mode, kerf, spacing, edgeTrim } = problem.rules;
  if (mode === 'guillotine') {
    const trim = stock.remnant ? 0 : edgeTrim;
    return { x0: trim, y0: trim, length: stock.length - trim, width: stock.width - trim, gap: kerf, trim };
  }
  return {
    x0: edgeTrim,
    y0: edgeTrim,
    length: stock.length - 2 * edgeTrim,
    width: stock.width - 2 * edgeTrim,
    gap: Math.max(spacing, kerf),
    trim: edgeTrim,
  };
}

function fits(item: Item, length: number, width: number): boolean {
  return (item.length <= length + EPS && item.width <= width + EPS) || (item.rotate && item.width <= length + EPS && item.length <= width + EPS);
}

// ---------------------------------------------------------------- guillotine --

interface Strip {
  x: number;
  depth: number;
  usedY: number;
  parts: { item: Item; y: number; length: number; width: number; rotated: boolean }[];
}

/**
 * Packs items onto one sheet as strips across it. `deep` chooses the part's
 * orientation when it opens a strip: its longer side along x, or its shorter.
 */
function packGuillotine(problem: SheetProblem, stockIndex: number, items: Item[], deep: boolean, nextFit = false): { packed: Packed; rest: Item[] } {
  const stock = problem.stock[stockIndex]!;
  const r = region(problem, stock);
  const strips: Strip[] = [];
  let cursor = 0;
  const rest: Item[] = [];
  const orientations = (item: Item) => {
    const list = [{ length: item.length, width: item.width, rotated: false }];
    if (item.rotate && Math.abs(item.length - item.width) > EPS) list.push({ length: item.width, width: item.length, rotated: true });
    return list;
  };

  for (const item of items) {
    let best: { strip: Strip; o: { length: number; width: number; rotated: boolean }; waste: number } | null = null;
    const candidates = nextFit ? strips.slice(-1) : strips;
    for (const strip of candidates) {
      for (const o of orientations(item)) {
        const y = strip.parts.length ? strip.usedY + r.gap : 0;
        if (o.length <= strip.depth + EPS && y + o.width <= r.width + EPS) {
          const waste = (strip.depth - o.length) * o.width;
          if (!best || waste < best.waste - EPS) best = { strip, o, waste };
        }
      }
    }
    if (best) {
      const y = best.strip.parts.length ? best.strip.usedY + r.gap : 0;
      best.strip.parts.push({ item, y, length: best.o.length, width: best.o.width, rotated: best.o.rotated });
      best.strip.usedY = y + best.o.width;
      continue;
    }
    // A new strip, in the orientation `deep` asks for when both fit.
    const x = strips.length ? cursor + r.gap : 0;
    const options = orientations(item)
      .filter((o) => x + o.length <= r.length + EPS && o.width <= r.width + EPS)
      .sort((a, b) => (deep ? b.length - a.length : a.length - b.length));
    const o = options[0];
    if (!o) {
      rest.push(item);
      continue;
    }
    strips.push({ x, depth: o.length, usedY: o.width, parts: [{ item, y: 0, length: o.length, width: o.width, rotated: o.rotated }] });
    cursor = x + o.length;
  }

  // Cuts in the order the operator makes them.
  const cuts: Cut[] = [];
  let order = 1;
  const X = (v: number) => r.x0 + v;
  const Y = (v: number) => r.y0 + v;
  if (r.trim > 0) {
    cuts.push({ order: order++, stage: 0, x1: r.trim, y1: 0, x2: r.trim, y2: stock.width });
    cuts.push({ order: order++, stage: 0, x1: r.trim, y1: r.trim, x2: stock.length, y2: r.trim });
  }
  const placements: Packed['placements'] = [];
  for (const strip of strips) {
    const end = strip.x + strip.depth;
    if (end < r.length - EPS) cuts.push({ order: order++, stage: 1, x1: X(end), y1: Y(0), x2: X(end), y2: stock.width });
    for (const part of strip.parts) {
      const bottom = part.y + part.width;
      if (bottom < r.width - EPS) cuts.push({ order: order++, stage: 2, x1: X(strip.x), y1: Y(bottom), x2: X(end), y2: Y(bottom) });
      if (part.length < strip.depth - EPS) {
        cuts.push({ order: order++, stage: 3, x1: X(strip.x + part.length), y1: Y(part.y), x2: X(strip.x + part.length), y2: Y(bottom) });
      }
      placements.push({ item: part.item, x: X(strip.x), y: Y(part.y), length: part.length, width: part.width, rotated: part.rotated });
    }
  }
  const remnants: Rect[] = [];
  const start = strips.length ? cursor + r.gap : 0;
  const remnant = { x: X(start), y: Y(0), length: stock.length - X(start), width: stock.width - Y(0) };
  if (problem.rules.minRemnant > 0 && Math.min(remnant.length, remnant.width) >= problem.rules.minRemnant - EPS && remnant.length > EPS) {
    remnants.push(remnant);
  }
  return { packed: { stock: stockIndex, placements, cuts, remnants }, rest };
}

// ----------------------------------------------------------------- free (MaxRects) --

interface Free {
  x: number;
  y: number;
  length: number;
  width: number;
}

/**
 * MaxRects on one sheet. Parts are inflated by the gap and the region grown
 * by it, so neighbouring parts end up `gap` apart. `leftmost` packs towards
 * x = 0 to keep a long offcut at the far end; otherwise best short side fit.
 */
function packFree(problem: SheetProblem, stockIndex: number, items: Item[], leftmost: boolean, nextFit = false): { packed: Packed; rest: Item[] } {
  const stock = problem.stock[stockIndex]!;
  const r = region(problem, stock);
  const L = r.length + r.gap;
  const W = r.width + r.gap;
  let free: Free[] = L > EPS && W > EPS ? [{ x: 0, y: 0, length: L, width: W }] : [];
  const placements: Packed['placements'] = [];
  const rest: Item[] = [];
  let failed = false;

  for (const item of items) {
    if (nextFit && failed) {
      rest.push(item);
      continue;
    }
    let best: { f: Free; l: number; w: number; rotated: boolean; s1: number; s2: number } | null = null;
    for (const f of free) {
      for (const [l, w, rotated] of [
        [item.length + r.gap, item.width + r.gap, false],
        ...(item.rotate ? [[item.width + r.gap, item.length + r.gap, true] as const] : []),
      ] as const) {
        if (l > f.length + EPS || w > f.width + EPS) continue;
        const s1 = leftmost ? f.x + l : Math.min(f.length - l, f.width - w);
        const s2 = leftmost ? f.y : Math.max(f.length - l, f.width - w);
        if (!best || s1 < best.s1 - EPS || (Math.abs(s1 - best.s1) <= EPS && s2 < best.s2 - EPS)) best = { f, l, w, rotated, s1, s2 };
      }
    }
    if (!best) {
      rest.push(item);
      failed = true;
      continue;
    }
    const used = { x: best.f.x, y: best.f.y, length: best.l, width: best.w };
    placements.push({
      item,
      x: r.x0 + used.x,
      y: r.y0 + used.y,
      length: best.l - r.gap,
      width: best.w - r.gap,
      rotated: best.rotated,
    });
    free = splitFree(free, used);
  }

  const remnants: Rect[] = [];
  const end = placements.reduce((max, p) => Math.max(max, p.x + p.length), r.x0 - r.gap);
  const remnant = { x: end + r.gap, y: 0, length: stock.length - (end + r.gap), width: stock.width };
  if (problem.rules.minRemnant > 0 && placements.length > 0 && Math.min(remnant.length, remnant.width) >= problem.rules.minRemnant - EPS) {
    remnants.push(remnant);
  }
  return { packed: { stock: stockIndex, placements, cuts: [], remnants }, rest };
}

function overlaps(a: Free, b: Free): boolean {
  return a.x < b.x + b.length - EPS && b.x < a.x + a.length - EPS && a.y < b.y + b.width - EPS && b.y < a.y + a.width - EPS;
}

function contains(a: Free, b: Free): boolean {
  return b.x >= a.x - EPS && b.y >= a.y - EPS && b.x + b.length <= a.x + a.length + EPS && b.y + b.width <= a.y + a.width + EPS;
}

function splitFree(free: Free[], used: Free): Free[] {
  const next: Free[] = [];
  for (const f of free) {
    if (!overlaps(f, used)) {
      next.push(f);
      continue;
    }
    if (used.x > f.x + EPS) next.push({ x: f.x, y: f.y, length: used.x - f.x, width: f.width });
    if (used.x + used.length < f.x + f.length - EPS) {
      next.push({ x: used.x + used.length, y: f.y, length: f.x + f.length - (used.x + used.length), width: f.width });
    }
    if (used.y > f.y + EPS) next.push({ x: f.x, y: f.y, length: f.length, width: used.y - f.y });
    if (used.y + used.width < f.y + f.width - EPS) {
      next.push({ x: f.x, y: used.y + used.width, length: f.length, width: f.y + f.width - (used.y + used.width) });
    }
  }
  return next.filter((a, i) => !next.some((b, j) => j !== i && contains(b, a) && (!contains(a, b) || j < i)));
}

// ----------------------------------------------------------------- planning --

function pack(problem: SheetProblem, stock: number, items: Item[], variant: boolean, nextFit = false) {
  return problem.rules.mode === 'guillotine'
    ? packGuillotine(problem, stock, items, variant, nextFit)
    : packFree(problem, stock, items, variant, nextFit);
}

function partsArea(packed: Packed): number {
  return packed.placements.reduce((sum, p) => sum + p.length * p.width, 0);
}

function availability(problem: SheetProblem): number[] {
  return problem.stock.map((s) => (s.available === null ? Number.POSITIVE_INFINITY : s.available));
}

function candidatesFor(problem: SheetProblem, available: number[], items: Item[]): number[] {
  const usable = (index: number) => {
    if (available[index]! <= 0) return false;
    const r = region(problem, problem.stock[index]!);
    return items.some((item) => fits(item, r.length, r.width));
  };
  const all = problem.stock.map((_, i) => i).filter(usable);
  if (problem.remnantsFirst) {
    const remnants = all.filter((i) => problem.stock[i]!.remnant);
    if (remnants.length) return [remnants.reduce((a, b) => (sheetArea(problem, a) <= sheetArea(problem, b) ? a : b))];
  }
  return all;
}

const sheetArea = (problem: SheetProblem, index: number) => problem.stock[index]!.length * problem.stock[index]!.width;

/** Sheet by sheet, each on the stock it fills best. */
function construct(problem: SheetProblem, items: Item[], variant: boolean, random: (() => number) | null): Packed[] {
  const available = availability(problem);
  const sheets: Packed[] = [];
  let remaining = items;
  while (remaining.length) {
    const candidates = candidatesFor(problem, available, remaining);
    let chosen: { packed: Packed; rest: Item[]; ratio: number } | null = null;
    for (const stock of candidates) {
      const result = pack(problem, stock, remaining, variant);
      if (!result.packed.placements.length) continue;
      const remnant = result.packed.remnants.reduce((sum, r) => sum + r.length * r.width, 0);
      // A kept remnant is not waste: judge a sheet by what it does not lose.
      const ratio = (partsArea(result.packed) + remnant) / sheetArea(problem, stock) + (random ? (random() - 0.5) * 0.01 : 0);
      if (!chosen || ratio > chosen.ratio) chosen = { ...result, ratio };
    }
    if (!chosen) break;
    available[chosen.packed.stock]! -= 1;
    sheets.push(chosen.packed);
    remaining = chosen.rest;
  }
  return sheets;
}

/** Cutting in order: the current sheet until a part does not fit, then the next. */
function nextFitSheets(problem: SheetProblem, items: Item[]): Packed[] {
  const available = availability(problem);
  const sheets: Packed[] = [];
  let remaining = items;
  while (remaining.length) {
    const first = remaining[0]!;
    // The first stock that holds the next part: smallest remnant, else the largest sheet.
    const holds = problem.stock
      .map((_, i) => i)
      .filter((i) => available[i]! > 0)
      .filter((i) => {
        const r = region(problem, problem.stock[i]!);
        return fits(first, r.length, r.width);
      });
    const remnants = problem.remnantsFirst ? holds.filter((i) => problem.stock[i]!.remnant) : [];
    const pool = remnants.length ? remnants : holds.filter((i) => !problem.remnantsFirst || !problem.stock[i]!.remnant);
    if (!pool.length) {
      remaining = remaining.slice(1);
      continue;
    }
    const stock = remnants.length
      ? pool.reduce((a, b) => (sheetArea(problem, a) <= sheetArea(problem, b) ? a : b))
      : pool.reduce((a, b) => (sheetArea(problem, a) >= sheetArea(problem, b) ? a : b));
    const { packed, rest } = pack(problem, stock, remaining, true, true);
    if (!packed.placements.length) {
      remaining = remaining.slice(1);
      continue;
    }
    available[stock]! -= 1;
    sheets.push(packed);
    remaining = rest;
  }
  return sheets;
}

interface Comparable {
  unplaced: number;
  stockArea: number;
  scrap: number;
  sheets: number;
}

function comparable(problem: SheetProblem, total: number, sheets: Packed[]): Comparable {
  let stockArea = 0;
  let scrap = 0;
  let placed = 0;
  for (const sheet of sheets) {
    const a = sheetArea(problem, sheet.stock);
    stockArea += a;
    placed += sheet.placements.length;
    scrap += a - partsArea(sheet) - sheet.remnants.reduce((sum, r) => sum + r.length * r.width, 0);
  }
  return { unplaced: total - placed, stockArea, scrap, sheets: sheets.length };
}

function better(a: Comparable, b: Comparable): boolean {
  if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
  if (Math.abs(a.stockArea - b.stockArea) > EPS) return a.stockArea < b.stockArea;
  if (Math.abs(a.scrap - b.scrap) > EPS) return a.scrap < b.scrap;
  return a.sheets < b.sheets;
}

function prepare(problem: SheetProblem) {
  const items: Item[] = [];
  const unplaced: SheetUnplaced[] = [];
  const regions = problem.stock.map((s) => region(problem, s));
  problem.pieces.forEach((piece, index) => {
    if (!piece.quantity) return;
    const item = { piece: index, length: piece.length, width: piece.width, rotate: piece.rotate };
    if (!regions.some((r) => fits(item, r.length, r.width))) {
      unplaced.push({ pieceId: piece.id, quantity: piece.quantity, reason: 'too-large' });
      return;
    }
    for (let n = 0; n < piece.quantity; n++) items.push({ ...item });
  });
  return { items, unplaced };
}

export function solveSheets(problem: SheetProblem): SheetPlan {
  validate(problem);
  const { items, unplaced } = prepare(problem);
  const random = createRandom(problem.seed);
  const effort = Math.max(1, Math.floor(problem.effort ?? DEFAULT_EFFORT));
  let best: Packed[] = [];
  let bestScore: Comparable | null = null;
  const consider = (sheets: Packed[]) => {
    const score = comparable(problem, items.length, sheets);
    if (!bestScore || better(score, bestScore)) {
      best = sheets;
      bestScore = score;
    }
  };
  for (const ordering of orderings) {
    const ordered = ordering(items, random);
    consider(construct(problem, ordered, true, null));
    consider(construct(problem, ordered, false, null));
  }
  consider(nextFitSheets(problem, items));
  for (let round = 0; round < effort; round++) {
    const base = orderings[round % orderings.length]!(items, random);
    // Swap neighbours now and then so each round sees a different order.
    const ordered = [...base];
    for (let i = 0; i + 1 < ordered.length; i++) if (random() < 0.2) [ordered[i], ordered[i + 1]] = [ordered[i + 1]!, ordered[i]!];
    if (round % 3 === 2) shuffle(ordered, random);
    consider(construct(problem, ordered, round % 2 === 0, random));
  }
  return toPlan(problem, best, unplaced, items);
}

export function baselineSheets(problem: SheetProblem): SheetPlan {
  validate(problem);
  const { items, unplaced } = prepare(problem);
  return toPlan(problem, nextFitSheets(problem, items), unplaced, items);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toPlan(problem: SheetProblem, sheets: Packed[], tooLarge: SheetUnplaced[], items: Item[]): SheetPlan {
  const unplaced = tooLarge.map((u) => ({ ...u }));
  const placed = new Map<number, number>();
  for (const sheet of sheets) for (const p of sheet.placements) placed.set(p.item.piece, (placed.get(p.item.piece) ?? 0) + 1);
  const wanted = new Map<number, number>();
  for (const item of items) wanted.set(item.piece, (wanted.get(item.piece) ?? 0) + 1);
  for (const [piece, count] of wanted) {
    const missing = count - (placed.get(piece) ?? 0);
    if (missing > 0) unplaced.push({ pieceId: problem.pieces[piece]!.id, quantity: missing, reason: 'no-stock' });
  }

  const groups = new Map<string, SheetLayout>();
  for (const sheet of sheets) {
    const stock = problem.stock[sheet.stock]!;
    const placements = sheet.placements
      .map((p) => ({
        pieceId: problem.pieces[p.item.piece]!.id,
        x: round(p.x),
        y: round(p.y),
        length: round(p.length),
        width: round(p.width),
        rotated: p.rotated,
      }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const parts = placements.reduce((sum, p) => sum + p.length * p.width, 0);
    const remnants = sheet.remnants.map((r) => ({ x: round(r.x), y: round(r.y), length: round(r.length), width: round(r.width) }));
    const remnantArea = remnants.reduce((sum, r) => sum + r.length * r.width, 0);
    const key = `${stock.id}\u0000${placements.map((p) => `${p.pieceId}@${p.x},${p.y},${p.rotated ? 1 : 0}`).join(';')}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      stockId: stock.id,
      sheetLength: stock.length,
      sheetWidth: stock.width,
      remnantStock: stock.remnant,
      count: 1,
      placements,
      cuts: sheet.cuts.map((c) => ({ ...c, x1: round(c.x1), y1: round(c.y1), x2: round(c.x2), y2: round(c.y2) })),
      remnants,
      edgeTrim: region(problem, stock).trim,
      partsArea: round(parts),
      remnantArea: round(remnantArea),
      scrapArea: round(stock.length * stock.width - parts - remnantArea),
    });
  }
  const layouts = [...groups.values()].sort(
    (a, b) => Number(b.remnantStock) - Number(a.remnantStock) || b.count - a.count || a.scrapArea - b.scrapArea,
  );
  return { solverVersion: SOLVER_VERSION, seed: problem.seed, layouts, unplaced, score: scoreSheets(layouts), optimal: false };
}

export function scoreSheets(layouts: SheetLayout[]): SheetScore {
  const score: SheetScore = { sheets: 0, stockArea: 0, partsArea: 0, remnantArea: 0, remnantCount: 0, scrapArea: 0, utilisation: 0, piecesPlaced: 0 };
  for (const layout of layouts) {
    const n = layout.count;
    score.sheets += n;
    score.stockArea += layout.sheetLength * layout.sheetWidth * n;
    score.partsArea += layout.partsArea * n;
    score.remnantArea += layout.remnantArea * n;
    score.remnantCount += layout.remnants.length * n;
    score.scrapArea += layout.scrapArea * n;
    score.piecesPlaced += layout.placements.length * n;
  }
  score.utilisation = score.stockArea > 0 ? score.partsArea / score.stockArea : 0;
  return score;
}
