import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { baselineSheets, solveSheets, type Placement, type SheetPlan, type SheetProblem } from '../src/index.js';

const EPS = 1e-6;

function problem(overrides: Partial<SheetProblem> = {}): SheetProblem {
  return {
    pieces: [],
    stock: [{ id: 'sheet', length: 3000, width: 1500, available: null, remnant: false }],
    rules: { mode: 'guillotine', kerf: 0, spacing: 0, edgeTrim: 0, minRemnant: 0 },
    remnantsFirst: true,
    seed: 1,
    ...overrides,
  };
}

function apart(a: Placement, b: Placement, gap: number): boolean {
  return (
    a.x + a.length + gap <= b.x + EPS ||
    b.x + b.length + gap <= a.x + EPS ||
    a.y + a.width + gap <= b.y + EPS ||
    b.y + b.width + gap <= a.y + EPS
  );
}

/** Whether straight end-to-end cuts can separate every part (recursively). */
function guillotineCuttable(parts: Placement[], x0: number, y0: number, x1: number, y1: number, kerf: number): boolean {
  if (parts.length <= 1) return true;
  const tryAxis = (axis: 'x' | 'y') => {
    const positions = [...new Set(parts.map((p) => (axis === 'x' ? p.x + p.length : p.y + p.width)))].sort((a, b) => a - b);
    for (const cut of positions) {
      const before = parts.filter((p) => (axis === 'x' ? p.x + p.length : p.y + p.width) <= cut + EPS);
      const after = parts.filter((p) => (axis === 'x' ? p.x : p.y) >= cut + kerf - EPS);
      if (before.length && after.length && before.length + after.length === parts.length) {
        return axis === 'x'
          ? guillotineCuttable(before, x0, y0, cut, y1, kerf) && guillotineCuttable(after, cut + kerf, y0, x1, y1, kerf)
          : guillotineCuttable(before, x0, y0, x1, cut, kerf) && guillotineCuttable(after, x0, cut + kerf, x1, y1, kerf);
      }
    }
    return false;
  };
  return tryAxis('x') || tryAxis('y');
}

function assertValid(input: SheetProblem, plan: SheetPlan): void {
  const { mode, kerf, spacing, edgeTrim } = input.rules;
  const gap = mode === 'guillotine' ? kerf : Math.max(kerf, spacing);
  const placed = new Map<string, number>();
  for (const layout of plan.layouts) {
    const stock = input.stock.find((s) => s.id === layout.stockId)!;
    const trim = mode === 'guillotine' ? (stock.remnant ? 0 : edgeTrim) : edgeTrim;
    const xMax = mode === 'guillotine' ? stock.length : stock.length - trim;
    const yMax = mode === 'guillotine' ? stock.width : stock.width - trim;
    for (const p of layout.placements) {
      const piece = input.pieces.find((q) => q.id === p.pieceId)!;
      expect(p.x).toBeGreaterThanOrEqual(trim - EPS);
      expect(p.y).toBeGreaterThanOrEqual(trim - EPS);
      expect(p.x + p.length).toBeLessThanOrEqual(xMax + EPS);
      expect(p.y + p.width).toBeLessThanOrEqual(yMax + EPS);
      const dims = p.rotated ? [p.width, p.length] : [p.length, p.width];
      expect(dims[0]).toBeCloseTo(piece.length, 6);
      expect(dims[1]).toBeCloseTo(piece.width, 6);
      if (p.rotated) expect(piece.rotate).toBe(true);
      placed.set(p.pieceId, (placed.get(p.pieceId) ?? 0) + layout.count);
    }
    for (let i = 0; i < layout.placements.length; i++) {
      for (let j = i + 1; j < layout.placements.length; j++) {
        expect(apart(layout.placements[i]!, layout.placements[j]!, gap)).toBe(true);
      }
    }
    for (const r of layout.remnants) {
      for (const p of layout.placements) expect(apart(p, { ...r, pieceId: '', rotated: false }, 0)).toBe(true);
    }
    if (mode === 'guillotine') expect(guillotineCuttable(layout.placements, trim, trim, stock.length, stock.width, kerf)).toBe(true);
    const total = layout.partsArea + layout.remnantArea + layout.scrapArea;
    expect(total).toBeCloseTo(layout.sheetLength * layout.sheetWidth, 3);
  }
  for (const u of plan.unplaced) placed.set(u.pieceId, (placed.get(u.pieceId) ?? 0) + u.quantity);
  for (const piece of input.pieces) expect(placed.get(piece.id) ?? 0).toBe(piece.quantity);
  const used = new Map<string, number>();
  for (const layout of plan.layouts) used.set(layout.stockId, (used.get(layout.stockId) ?? 0) + layout.count);
  for (const stock of input.stock) if (stock.available !== null) expect(used.get(stock.id) ?? 0).toBeLessThanOrEqual(stock.available);
}

describe('solveSheets, guillotine', () => {
  it('packs parts that tile the sheet exactly into one sheet', () => {
    const input = problem({ pieces: [{ id: 'a', length: 1000, width: 500, quantity: 9, rotate: false }] });
    const plan = solveSheets(input);
    expect(plan.score.sheets).toBe(1);
    expect(plan.score.utilisation).toBeCloseTo(1, 6);
    assertValid(input, plan);
  });

  it('numbers the cuts in order: edge trim, strips, parts, trims', () => {
    const input = problem({
      rules: { mode: 'guillotine', kerf: 3, spacing: 0, edgeTrim: 5, minRemnant: 0 },
      pieces: [
        { id: 'a', length: 1200, width: 700, quantity: 2, rotate: false },
        { id: 'b', length: 1000, width: 400, quantity: 1, rotate: false },
      ],
    });
    const plan = solveSheets(input);
    const [layout] = plan.layouts;
    expect(layout!.cuts.map((c) => c.order)).toEqual(layout!.cuts.map((_, i) => i + 1));
    expect(layout!.cuts.slice(0, 2).every((c) => c.stage === 0)).toBe(true);
    expect(layout!.cuts.some((c) => c.stage === 1)).toBe(true);
    assertValid(input, plan);
  });

  it('rotates parts only when allowed', () => {
    const tall = { id: 't', length: 400, width: 1400, quantity: 1 };
    const sheet = [{ id: 's', length: 1450, width: 450, available: null, remnant: false }];
    expect(solveSheets(problem({ stock: sheet, pieces: [{ ...tall, rotate: false }] })).unplaced[0]?.reason).toBe('too-large');
    const plan = solveSheets(problem({ stock: sheet, pieces: [{ ...tall, rotate: true }] }));
    expect(plan.layouts[0]!.placements[0]!.rotated).toBe(true);
  });

  it('keeps the end of the sheet as a remnant', () => {
    const input = problem({
      rules: { mode: 'guillotine', kerf: 3, spacing: 0, edgeTrim: 0, minRemnant: 300 },
      pieces: [{ id: 'a', length: 1000, width: 1500, quantity: 1, rotate: false }],
    });
    const layout = solveSheets(input).layouts[0]!;
    expect(layout.remnants).toEqual([{ x: 1003, y: 0, length: 1997, width: 1500 }]);
  });

  it('uses remnants first and gives them no edge trim', () => {
    const input = problem({
      rules: { mode: 'guillotine', kerf: 0, spacing: 0, edgeTrim: 10, minRemnant: 0 },
      stock: [
        { id: 'sheet', length: 3000, width: 1500, available: null, remnant: false },
        { id: 'rem', length: 800, width: 600, available: 1, remnant: true },
      ],
      pieces: [{ id: 'a', length: 800, width: 600, quantity: 1, rotate: false }],
    });
    const layout = solveSheets(input).layouts[0]!;
    expect(layout.stockId).toBe('rem');
    expect(layout.placements[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('beats or matches cutting in order', () => {
    const input = problem({
      rules: { mode: 'guillotine', kerf: 3, spacing: 0, edgeTrim: 5, minRemnant: 0 },
      pieces: [
        { id: 'a', length: 1300, width: 300, quantity: 7, rotate: true },
        { id: 'b', length: 400, width: 650, quantity: 9, rotate: true },
        { id: 'c', length: 900, width: 900, quantity: 3, rotate: true },
      ],
    });
    expect(solveSheets(input).score.stockArea).toBeLessThanOrEqual(baselineSheets(input).score.stockArea);
  });

  it('is deterministic for a seed', () => {
    const input = problem({
      seed: 7,
      pieces: [
        { id: 'a', length: 730, width: 410, quantity: 13, rotate: true },
        { id: 'b', length: 1220, width: 280, quantity: 6, rotate: true },
      ],
    });
    expect(solveSheets(input)).toEqual(solveSheets(input));
  });
});

describe('solveSheets, free', () => {
  it('keeps parts apart by the spacing and away from the edges', () => {
    const input = problem({
      rules: { mode: 'free', kerf: 0.3, spacing: 5, edgeTrim: 8, minRemnant: 0 },
      pieces: [{ id: 'a', length: 300, width: 200, quantity: 20, rotate: true }],
    });
    const plan = solveSheets(input);
    expect(plan.score.sheets).toBe(1);
    assertValid(input, plan);
  });

  it('packs towards one end and keeps the rest as a remnant', () => {
    const input = problem({
      rules: { mode: 'free', kerf: 0.3, spacing: 5, edgeTrim: 8, minRemnant: 300 },
      pieces: [{ id: 'a', length: 300, width: 200, quantity: 6, rotate: false }],
    });
    const layout = solveSheets(input).layouts[0]!;
    expect(layout.remnants).toHaveLength(1);
    expect(layout.remnants[0]!.length).toBeGreaterThan(2000);
  });

  it('solves a hundred parts quickly', () => {
    const pieces = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, length: 120 + ((i * 137) % 700), width: 80 + ((i * 89) % 500), quantity: 5, rotate: true }));
    const started = performance.now();
    const plan = solveSheets(problem({ rules: { mode: 'free', kerf: 0.3, spacing: 5, edgeTrim: 8, minRemnant: 0 }, pieces }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(plan.unplaced).toEqual([]);
  });
});

describe('properties', () => {
  const arbitrary = fc
    .record({
      mode: fc.constantFrom('guillotine' as const, 'free' as const),
      kerf: fc.constantFrom(0, 0.3, 3),
      spacing: fc.constantFrom(0, 5, 10),
      edgeTrim: fc.constantFrom(0, 5, 10),
      minRemnant: fc.constantFrom(0, 200),
      remnantsFirst: fc.boolean(),
      seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
      pieces: fc.array(
        fc.record({
          length: fc.integer({ min: 20, max: 1600 }),
          width: fc.integer({ min: 20, max: 1600 }),
          quantity: fc.integer({ min: 0, max: 6 }),
          rotate: fc.boolean(),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      stock: fc.array(
        fc.record({
          length: fc.integer({ min: 300, max: 3000 }),
          width: fc.integer({ min: 300, max: 1500 }),
          available: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
          remnant: fc.boolean(),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    })
    .map(
      (v): SheetProblem => ({
        rules: { mode: v.mode, kerf: v.kerf, spacing: v.spacing, edgeTrim: v.edgeTrim, minRemnant: v.minRemnant },
        remnantsFirst: v.remnantsFirst,
        seed: v.seed,
        effort: 2,
        pieces: v.pieces.map((p, i) => ({ id: `p${i}`, ...p })),
        stock: v.stock.map((s, i) => ({ id: `s${i}`, ...s })),
      }),
    );

  it('plans and baselines are cuttable, inside the sheet, apart and complete', () => {
    fc.assert(
      fc.property(arbitrary, (input) => {
        assertValid(input, solveSheets(input));
        assertValid(input, baselineSheets(input));
      }),
      { numRuns: 150 },
    );
  });

  it('never places fewer parts than the baseline', () => {
    fc.assert(
      fc.property(arbitrary, (input) => {
        expect(solveSheets(input).score.piecesPlaced).toBeGreaterThanOrEqual(baselineSheets(input).score.piecesPlaced);
      }),
      { numRuns: 150 },
    );
  });
});
