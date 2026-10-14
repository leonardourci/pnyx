// The packages semantic search runs on, node-llama-cpp and sqlite-vec, pinned and
// installed by `search setup --semantic` into $PNYX_HOME/runtime/ rather than with
// pnyx-axi, so a machine that never turns semantic search on never downloads them.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BoardError } from '../core/model.ts'
import { pnyxHome } from '../store/board-store.ts'

export const RUNTIME = { 'node-llama-cpp': '3.22.1', 'sqlite-vec': '0.1.9' }
export const RUNTIME_LABEL = Object.entries(RUNTIME).map(([name, version]) => `${name}@${version}`)
  .join(' ')

export const runtimeDir = () => join(pnyxHome(), 'runtime')

// Resolves and loads packages from the runtime folder.
export const runtimeRequire = () => createRequire(join(runtimeDir(), 'package.json'))

export function runtimeInstalled(): boolean {
  return Object.entries(RUNTIME).every(([name, version]) => {
    try {
      return (JSON.parse(readFileSync(join(runtimeDir(), 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }).version === version
    } catch {
      return false
    }
  })
}

// Installs the pinned packages with npm, starting over from an empty folder.
export function installRuntime(): 'present' | 'installed' {
  if (runtimeInstalled()) {
    return 'present'
  }

  rmSync(runtimeDir(), { recursive: true, force: true })
  mkdirSync(runtimeDir(), { recursive: true })
  writeFileSync(join(runtimeDir(), 'package.json'), `${JSON.stringify({ private: true, dependencies: RUNTIME }, null, 2)}\n`)

  try {
    // node-llama-cpp's prebuilt binaries come as optional dependencies; its install script would build from source.
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: runtimeDir(),
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    rmSync(runtimeDir(), { recursive: true, force: true })
    const why = (error as { stderr?: Buffer }).stderr?.toString().trim() || (error as Error).message
    throw new BoardError(`installing ${RUNTIME_LABEL} failed: ${why}`, 'INSTALL_FAILED', ['Check the network and that npm is on PATH, then run `pnyx-axi search setup --semantic` again'])
  }

  return 'installed'
}

export function runtimeBytes(): number {
  return readdirSync(runtimeDir(), { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .reduce((sum, e) => sum + statSync(join(e.parentPath, e.name)).size, 0)
}
