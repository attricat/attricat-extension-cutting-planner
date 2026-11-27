// Bundles each Frame UI artifact into one self-contained ES module. Attricat
// imports it into a sandboxed, opaque-origin iframe with no network, so
// nothing may load at runtime. The solver Worker is bundled first and
// inlined as text; the planner starts it from a Blob URL.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const sources = {
  planner: 'client/src/planner/main.tsx',
  'plan-tab': 'client/src/tab/main.tsx',
  'cutting-sheet-dialog': 'client/src/dialog/main.tsx',
};
const common = {
  bundle: true,
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  conditions: ['source'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};

const worker = await build({ ...common, entryPoints: ['client/src/solver-worker.ts'], format: 'iife', write: false });
const workerSource = worker.outputFiles[0].text;

const entryPoints = {};
for (const artifact of manifest.artifacts.filter((item) => item.kind === 'client_frame')) {
  const source = sources[artifact.id];
  if (!source) throw new Error(`No client source for artifact '${artifact.id}'`);
  entryPoints[artifact.path.replace(/^dist\//, '').replace(/\.js$/, '')] = source;
}
const result = await build({
  ...common,
  entryPoints,
  outdir: 'dist',
  format: 'esm',
  jsx: 'automatic',
  define: { ...common.define, __SOLVER_WORKER__: JSON.stringify(workerSource) },
  metafile: true,
});
for (const [file, output] of Object.entries(result.metafile.outputs)) {
  console.log(`${file} ${(output.bytes / 1024).toFixed(0)} KiB`);
}
