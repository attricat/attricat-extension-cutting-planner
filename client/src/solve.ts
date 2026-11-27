// Solves cutting problems in a Worker started from a Blob URL (the frame's
// content security policy allows blob: scripts). If the Worker cannot start,
// it solves on the page instead; the plan is the same either way.
import {
  baselineBars,
  baselineSheets,
  solveBars,
  solveSheets,
  type BarPlan,
  type BarProblem,
  type SheetPlan,
  type SheetProblem,
} from '../../solver/src/index.js';

declare const __SOLVER_WORKER__: string;

export type Job = { kind: 'bar'; problem: BarProblem } | { kind: 'sheet'; problem: SheetProblem };
export type Solved<P> = { plan: P; baseline: P };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function startWorker(): Worker | null {
  try {
    const url = URL.createObjectURL(new Blob([__SOLVER_WORKER__], { type: 'text/javascript' }));
    const started = new Worker(url);
    started.onmessage = (event) => {
      const { id, result, error } = event.data;
      const entry = pending.get(id);
      pending.delete(id);
      if (!entry) return;
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    started.onerror = () => {
      // A worker that fails to load falls back for every pending problem.
      worker = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(new Error('worker failed'));
      }
    };
    return started;
  } catch {
    return null;
  }
}

/** Records where plans are computed, for diagnostics and the e2e suite. */
function mark(where: 'worker' | 'page') {
  document.documentElement.dataset.solver = where;
}

function solveHere(job: Job): Solved<BarPlan> | Solved<SheetPlan> {
  mark('page');
  return job.kind === 'bar'
    ? { plan: solveBars(job.problem), baseline: baselineBars(job.problem) }
    : { plan: solveSheets(job.problem), baseline: baselineSheets(job.problem) };
}

async function run(job: Job): Promise<unknown> {
  if (worker === undefined) worker = startWorker();
  if (!worker) return solveHere(job);
  const id = nextId++;
  try {
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker!.postMessage({ id, job });
    });
    mark('worker');
    return result;
  } catch {
    return solveHere(job);
  }
}

export function solveBarJob(problem: BarProblem): Promise<Solved<BarPlan>> {
  return run({ kind: 'bar', problem }) as Promise<Solved<BarPlan>>;
}

export function solveSheetJob(problem: SheetProblem): Promise<Solved<SheetPlan>> {
  return run({ kind: 'sheet', problem }) as Promise<Solved<SheetPlan>>;
}
