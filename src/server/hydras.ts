import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { commands } from '../cli/commands.ts'
import { hydraConfig } from '../core/hydra.ts'
import { HydraError } from '../core/model.ts'
import { loadHydra, pnyxHome } from '../store/hydra-store.ts'
import { readServer } from './state.ts'

const START_TIMEOUT_MS = 10_000
const CLI = join(import.meta.dirname, '..', 'cli', import.meta.url.endsWith('.ts') ? 'pnyx-axi.ts' : 'pnyx-axi.js')

export interface HydraTab { id: string; name: string; hydra: string }

export function listHydras(): HydraTab[] {
  let ids: string[] = []

  try {
    ids = readdirSync(join(pnyxHome(), 'boards'), { withFileTypes: true }).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { /* No hydras yet. */ }

  return ids.sort().map(id => {
    const config = hydraConfig({ state: loadHydra({ hydraId: id }).state, id })

    return { id, name: config.name, hydra: config.hydra.kind === 'firstmate' ? `Firstmate ${config.hydra.home}` : config.hydra.name }
  })
}

export async function openHydra({ id }: { id: string }): Promise<string> {
  if (!listHydras().some(b => b.id === id)) {
    throw new HydraError({ message: `Hydra not found: ${id}`, code: 'NOT_FOUND' })
  }

  const running = await readServer({ hydraId: id })

  if (running) {
    return running.url
  }

  spawn(process.execPath, [CLI, 'serve', '--hydra', id, '--port', '0'], { detached: true, stdio: 'ignore' }).unref()

  for (const end = Date.now() + START_TIMEOUT_MS; Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, 200))
    const started = await readServer({ hydraId: id })

    if (started) {
      return started.url
    }
  }

  throw new HydraError({ message: `Hydra ${id} did not start`, code: 'NOT_STARTED', help: [`Run \`pnyx-axi serve --hydra ${id}\``] })
}

export function createHydra({ name }: { name: string }): string {
  const taken = new Set(listHydras().map(b => b.id))
  let n = taken.size + 1

  while (taken.has(`hydra-${n}`)) {
    n++
  }

  const id = `hydra-${n}`
  commands.hydra(['create', id, '--name', name, '--actor', 'web'])

  return id
}

export function renameHydra({ id, name }: { id: string; name: string }): void {
  commands.hydra(['set', '--hydra', id, '--name', name, '--actor', 'web'])
}
