// Runs the solvers off the page's main thread. Bundled on its own and inlined
// into the planner as text (see scripts/build-client.mjs).
import { baselineBars, baselineSheets, solveBars, solveSheets } from '../../solver/src/index.js';
import type { Job } from './solve.js';

self.onmessage = (event: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = event.data;
  try {
    const result =
      job.kind === 'bar'
        ? { plan: solveBars(job.problem), baseline: baselineBars(job.problem) }
        : { plan: solveSheets(job.problem), baseline: baselineSheets(job.problem) };
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
