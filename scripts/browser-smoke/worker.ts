// The Web Worker file for the threaded browser smoke — the exact shape a real app ships: import the
// worker host from the scheduler's browser entry (the '@ecsia/scheduler/worker' subpath; here the
// dist file directly, since this smoke exercises SHIPPED artifacts), bundle the kernels statically,
// install. esbuild bundles this to dist/worker.js; entry.ts spawns it via
// `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.

import { ecsiaWorker } from '../../packages/scheduler/dist/workers/browser-entry.js'
import { buildWorkerKernels } from './threaded-fixture.js'

ecsiaWorker(buildWorkerKernels)
