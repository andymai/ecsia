// The Web Worker file: the ecsia worker host + the statically bundled field kernels.
// Spawned by the page as new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }).

import { ecsiaWorker } from '@ecsia/scheduler/worker'
import { buildWorkerKernels } from './src/sim/kernels.js'

ecsiaWorker(buildWorkerKernels)
