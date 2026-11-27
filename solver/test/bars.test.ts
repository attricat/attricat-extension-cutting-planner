import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { baselineBars, solveBars, type BarPlan, type BarProblem } from '../src/index.js';

const rules = { kerf: 3, startTrim: 10, minRemnant: 500 };

function problem(overrides: Partial<BarProblem> = {}): BarProblem {
  return {
    pieces: [],
    stock: [{ id: 'bar-6000', length: 6000, available: null, remnant: false }],
    rules,
    remnantsFirst: true,
    seed: 1,
    ...overrides,
  };
}

/** Every bar is physically cuttable: pieces in order, kerf between, nothing past the end. */
function assertCuttable(input: BarProblem, plan: BarPlan): void {
  const kerf = input.rules.kerf;
  for (const layout of plan.layouts) {
    expect(layout.count).toBeGreaterThan(0);
    let end = layout.trim;
    for (const cut of layout.cuts) {
      expect(cut.offset).toBeCloseTo(end, 6);
      end = cut.offset + cut.length + kerf;
    }
    const lastPieceEnd = end - (layout.cuts.length ? kerf : 0);
    expect(lastPieceEnd).toBeLessThanOrEqual(layout.stockLength + 1e-6);
    const total = layout.trim + layout.cuts.reduce((sum, cut) => sum + cut.length, 0) + layout.kerf + layout.offcut;
    expect(total).toBeCloseTo(layout.stockLength, 6);
    expect(layout.kerf).toBeLessThanOrEqual(layout.cuts.length * kerf + 1e-6);
  }
}

/** Every piece is either placed exactly its quantity or reported unplaced. */
function assertAccounted(input: BarProblem, plan: BarPlan): void {
  const placed = new Map<string, number>();
  for (const layout of plan.layouts) {
    for (const cut of layout.cuts) placed.set(cut.pieceId, (placed.get(cut.pieceId) ?? 0) + layout.count);
  }
  for (const entry of plan.unplaced) placed.set(entry.pieceId, (placed.get(entry.pieceId) ?? 0) + entry.quantity);
  for (const piece of input.pieces) expect(placed.get(piece.id) ?? 0).toBe(piece.quantity);
}

function assertStockRespected(input: BarProblem, plan: BarPlan): void {
  const used = new Map<string, number>();
  for (const layout of plan.layouts) used.set(layout.stockId, (used.get(layout.stockId) ?? 0) + layout.count);
  for (const stock of input.stock) {
    if (stock.available !== null) expect(used.get(stock.id) ?? 0).toBeLessThanOrEqual(stock.available);
  }
}

describe('solveBars', () => {
  it('packs complementary pieces into the fewest bars and proves it', () => {
    const input = problem({
      rules: { kerf: 0, startTrim: 0, minRemnant: 0 },
      pieces: [
        { id: 'a', length: 4000, quantity: 3 },
        { id: 'b', length: 2000, quantity: 3 },
      ],
    });
    const plan = solveBars(input);
    expect(plan.score.bars).toBe(3);
    expect(plan.optimal).toBe(true);
    expect(plan.layouts).toHaveLength(1);
    expect(plan.layouts[0]!.count).toBe(3);
    expect(plan.score.utilisation).toBe(1);
  });

  it('adds kerf per cut and trims the start of full bars', () => {
    const input = problem({ pieces: [{ id: 'a', length: 1000, quantity: 5 }] });
    const plan = solveBars(input);
    expect(plan.score.bars).toBe(1);
    const [layout] = plan.layouts;
    expect(layout!.trim).toBe(10);
    expect(layout!.cuts.map((cut) => cut.offset)).toEqual([10, 1013, 2016, 3019, 4022]);
    expect(layout!.kerf).toBe(15);
    expect(layout!.offcut).toBe(975);
    expect(layout!.offcutKind).toBe('remnant');
  });

  it('lets the last cut run off the end when less than a kerf is left', () => {
    const input = problem({
      rules: { kerf: 3, startTrim: 0, minRemnant: 0 },
      pieces: [{ id: 'a', length: 1998, quantity: 3 }],
    });
    const plan = solveBars(input);
    expect(plan.score.bars).toBe(1);
    expect(plan.layouts[0]!.kerf).toBe(6);
    expect(plan.layouts[0]!.offcut).toBe(0);
  });

  it('marks short offcuts as scrap and long ones as remnants', () => {
    const input = problem({ pieces: [{ id: 'a', length: 5800, quantity: 1 }, { id: 'b', length: 3000, quantity: 1 }] });
    const plan = solveBars(input);
    const kinds = plan.layouts.map((layout) => [layout.cuts[0]!.pieceId, layout.offcutKind]).sort();
    expect(kinds).toEqual([
      ['a', 'scrap'],
      ['b', 'remnant'],
    ]);
  });

  it('uses remnants before full bars, smallest first', () => {
    const input = problem({
      stock: [
        { id: 'bar-6000', length: 6000, available: null, remnant: false },
        { id: 'rem-2500', length: 2500, available: 1, remnant: true },
        { id: 'rem-1200', length: 1200, available: 1, remnant: true },
      ],
      pieces: [{ id: 'a', length: 1100, quantity: 1 }],
    });
    const plan = solveBars(input);
    expect(plan.layouts.map((layout) => layout.stockId)).toEqual(['rem-1200']);
    expect(plan.layouts[0]!.trim).toBe(0);
  });

  it('ignores the remnant preference when asked', () => {
    const input = problem({
      remnantsFirst: false,
      stock: [
        { id: 'bar-6000', length: 6000, available: null, remnant: false },
        { id: 'rem-1200', length: 1200, available: 5, remnant: true },
      ],
      pieces: [{ id: 'a', length: 1100, quantity: 5 }],
    });
    expect(solveBars(input).layouts.map((layout) => layout.stockId)).toEqual(['bar-6000']);
  });

  it('picks the stock length that wastes least', () => {
    const input = problem({
      rules: { kerf: 0, startTrim: 0, minRemnant: 0 },
      stock: [
        { id: 'bar-6000', length: 6000, available: null, remnant: false },
        { id: 'bar-4000', length: 4000, available: null, remnant: false },
      ],
      pieces: [{ id: 'a', length: 2000, quantity: 2 }],
    });
    const plan = solveBars(input);
    expect(plan.layouts.map((layout) => [layout.stockId, layout.count])).toEqual([['bar-4000', 1]]);
  });

  it('reports pieces longer than any bar and pieces without stock', () => {
    const input = problem({
      stock: [{ id: 'bar-6000', length: 6000, available: 1, remnant: false }],
      pieces: [
        { id: 'long', length: 7000, quantity: 2 },
        { id: 'a', length: 4000, quantity: 2 },
      ],
    });
    const plan = solveBars(input);
    expect(plan.unplaced).toEqual(
      expect.arrayContaining([
        { pieceId: 'long', quantity: 2, reason: 'too-long' },
        { pieceId: 'a', quantity: 1, reason: 'no-stock' },
      ]),
    );
    expect(plan.optimal).toBe(false);
  });

  it('handles decimal lengths and kerf', () => {
    const input = problem({
      rules: { kerf: 2.5, startTrim: 0, minRemnant: 0 },
      pieces: [{ id: 'a', length: 1497.5, quantity: 4 }],
    });
    const plan = solveBars(input);
    expect(plan.score.bars).toBe(1);
    expect(plan.layouts[0]!.cuts.map((cut) => cut.offset)).toEqual([0, 1500, 3000, 4500]);
  });

  it('gives the same plan for the same seed', () => {
    const input = problem({
      pieces: [
        { id: 'a', length: 1234, quantity: 17 },
        { id: 'b', length: 777, quantity: 23 },
        { id: 'c', length: 2501, quantity: 9 },
      ],
      seed: 42,
    });
    expect(solveBars(input)).toEqual(solveBars(input));
  });

  it('beats or matches cutting in order', () => {
    const input = problem({
      pieces: [
        { id: 'a', length: 3500, quantity: 6 },
        { id: 'b', length: 2400, quantity: 6 },
        { id: 'c', length: 600, quantity: 10 },
      ],
    });
    const plan = solveBars(input);
    const baseline = baselineBars(input);
    expect(plan.score.stockLength).toBeLessThan(baseline.score.stockLength);
  });

  it('solves a few hundred cuts quickly', () => {
    const pieces = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, length: 300 + ((i * 397) % 2700), quantity: 10 }));
    const started = performance.now();
    const plan = solveBars(problem({ pieces }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(plan.unplaced).toEqual([]);
  });
});

describe('baselineBars', () => {
  it('cuts lines in order on the current bar or the next', () => {
    const input = problem({
      rules: { kerf: 0, startTrim: 0, minRemnant: 0 },
      pieces: [
        { id: 'a', length: 4000, quantity: 2 },
        { id: 'b', length: 2000, quantity: 2 },
      ],
    });
    // a | a b | b: next fit never goes back to an earlier bar.
    expect(baselineBars(input).score.bars).toBe(3);
  });
});

describe('properties', () => {
  const arbitraryProblem = fc
    .record({
      kerf: fc.constantFrom(0, 2, 2.5, 3, 4),
      startTrim: fc.constantFrom(0, 5, 10),
      minRemnant: fc.constantFrom(0, 300, 1000),
      remnantsFirst: fc.boolean(),
      seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
      pieces: fc.array(
        fc.record({ length: fc.integer({ min: 50, max: 7000 }), quantity: fc.integer({ min: 0, max: 12 }) }),
        { minLength: 1, maxLength: 8 },
      ),
      stock: fc.array(
        fc.record({
          length: fc.integer({ min: 500, max: 12000 }),
          available: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
          remnant: fc.boolean(),
        }),
        { minLength: 1, maxLength: 4 },
      ),
    })
    .map(
      (value): BarProblem => ({
        rules: { kerf: value.kerf, startTrim: value.startTrim, minRemnant: value.minRemnant },
        remnantsFirst: value.remnantsFirst,
        seed: value.seed,
        effort: 4,
        pieces: value.pieces.map((piece, i) => ({ id: `p${i}`, ...piece })),
        stock: value.stock.map((stock, i) => ({ id: `s${i}`, ...stock })),
      }),
    );

  it('places every piece once, respects kerf, trim and stock, for the plan and the baseline', () => {
    fc.assert(
      fc.property(arbitraryProblem, (input) => {
        for (const plan of [solveBars(input), baselineBars(input)]) {
          assertCuttable(input, plan);
          assertAccounted(input, plan);
          assertStockRespected(input, plan);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never places fewer pieces than the baseline', () => {
    fc.assert(
      fc.property(arbitraryProblem, (input) => {
        expect(solveBars(input).score.piecesPlaced).toBeGreaterThanOrEqual(baselineBars(input).score.piecesPlaced);
      }),
      { numRuns: 200 },
    );
  });
});
