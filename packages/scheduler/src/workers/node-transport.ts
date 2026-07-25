// The node:worker_threads transport — the pool's default when no transport is injected. Bootstrap
// rides `workerData`; kernels resolve worker-side by importing the bootstrap's kernelModule.

// node:worker_threads / node:url load lazily inside spawn(): a static `node:*` import here would
// break every browser bundle that merely *includes* this module, and bundlers resolve literal
// dynamic specifiers at build time too — the template literal keeps the specifier opaque. Node
// resolves it at runtime; browsers never reach it (this transport is Node-only by design).
const nodeImport = <T>(mod: string): Promise<T> => import(`node:${mod}`) as Promise<T>

import type { WorkerBootstrap } from './manifest.js'
import type { WorkerPort, WorkerTransport } from './transport.js'

export const nodeWorkerTransport: WorkerTransport = {
  mainThreadMayBlock: true, // Node main blocks on the wave fence directly (tier 2)
  async spawn(boot: WorkerBootstrap, opts: { readonly workerEntryUrl?: string | undefined }): Promise<WorkerPort> {
    const [{ Worker: NodeWorker }, { fileURLToPath }] = await Promise.all([
      nodeImport<typeof import('node:worker_threads')>('worker_threads'),
      nodeImport<typeof import('node:url')>('url'),
    ])
    const here = fileURLToPath(import.meta.url)
    const entryUrl = opts.workerEntryUrl ?? here.replace(/node-transport\.(js|ts)$/, 'worker-entry.$1')
    const worker = new NodeWorker(entryUrl, { workerData: boot })
    return {
      postMessage: (msg) => worker.postMessage(msg),
      onMessage: (cb) => worker.on('message', cb),
      onError: (cb) => worker.on('error', cb),
      terminate: async () => {
        await worker.terminate()
      },
    }
  },
}
