import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export function runtimeInstalled(): boolean {
  try {
    import.meta.resolve('node-llama-cpp')
    require.resolve('sqlite-vec')

    return true
  } catch {
    return false
  }
}

// node-llama-cpp's entry from its real path. In the worker process Node resolved
// the bare name to pnpm's symlink without following it, so the package's own
// dependencies (next to its real folder) could not be found.
export const llamaCppUrl = () => pathToFileURL(realpathSync(fileURLToPath(import.meta.resolve('node-llama-cpp')))).href

export const sqliteVecPath = () => (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath()
