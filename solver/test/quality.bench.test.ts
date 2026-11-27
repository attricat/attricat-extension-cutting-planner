import { it } from 'vitest';
import { solveBars, baselineBars, createRandom } from '../src/index.js';
it.skipIf(!process.env.BENCH)('quality', () => {
  const r = createRandom(7);
  let optimal = 0, gap = 0, saved = 0, time = 0;
  const N = 40;
  for (let k = 0; k < N; k++) {
    const pieces = Array.from({ length: 5 + Math.floor(r() * 25) }, (_, i) => ({ id: `p${i}`, length: 200 + Math.floor(r() * 2800), quantity: 1 + Math.floor(r() * 12) }));
    const input = { pieces, stock: [{ id: 's', length: 6000, available: null, remnant: false }], rules: { kerf: 3, startTrim: 10, minRemnant: 500 }, remnantsFirst: true, seed: 1, effort: Number(process.env.EFFORT ?? 24) };
    const t = performance.now(); const plan = solveBars(input); time = Math.max(time, performance.now() - t);
    const total = pieces.reduce((s, p) => s + (p.length + 3) * p.quantity, 0);
    const lb = Math.ceil(total / (6000 - 10 + 3));
    if (plan.optimal) optimal++; gap += plan.score.bars - lb;
    saved += baselineBars(input).score.bars - plan.score.bars;
  }
  console.log({ N, optimal, extraBarsOverBound: gap, barsSavedVsBaseline: saved, worstMs: Math.round(time) });
});
