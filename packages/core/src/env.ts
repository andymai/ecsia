// Portable dev-mode detection. Evaluated ONCE: browsers have no `process` (typeof guard),
// permission-less Deno THROWS on env access (try/catch), Node reads NODE_ENV. Defaults to
// dev=true where unknowable — extra guards beat silent production behavior in a sandbox.
export const IS_DEV: boolean = (() => {
  try {
    return typeof process === 'undefined' || process.env?.['NODE_ENV'] !== 'production'
  } catch {
    return true
  }
})()
