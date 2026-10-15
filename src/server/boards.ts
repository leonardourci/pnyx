// The boards a tab can switch to. Each board keeps its own server, so opening one
// starts `pnyx-axi serve` for it when none is running and returns its address.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { commands } from '../cli/commands.ts'
import { boardConfig } from '../core/hydra.ts'
import { BoardError } from '../core/model.ts'
import { loadBoard, pnyxHome } from '../store/board-store.ts'
import { readServer } from './state.ts'

const START_TIMEOUT_MS = 10_000
const CLI = join(import.meta.dirname, '..', 'cli', import.meta.url.endsWith('.ts') ? 'pnyx-axi.ts' : 'pnyx-axi.js')

export interface BoardTab { id: string; name: string; hydra: string }

export function listBoards(): BoardTab[] {
  let ids: string[] = []

  try {
    ids = readdirSync(join(pnyxHome(), 'boards'), { withFileTypes: true }).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { /* No boards yet. */ }

  return ids.sort().map(id => {
    const config = boardConfig({ state: loadBoard({ board: id }).state, id })

    return { id, name: config.name, hydra: config.hydra.kind === 'firstmate' ? `Firstmate ${config.hydra.home}` : config.hydra.name }
  })
}

// The board's running server, started in the background when there is none.
export async function openBoard({ id }: { id: string }): Promise<string> {
  if (!listBoards().some(b => b.id === id)) {
    throw new BoardError({ message: `board not found: ${id}`, code: 'NOT_FOUND' })
  }

  const running = await readServer({ board: id })

  if (running) {
    return running.url
  }

  spawn(process.execPath, [CLI, 'serve', '--board', id, '--port', '0'], { detached: true, stdio: 'ignore' }).unref()

  for (const end = Date.now() + START_TIMEOUT_MS; Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, 200))
    const started = await readServer({ board: id })

    if (started) {
      return started.url
    }
  }

  throw new BoardError({ message: `board ${id} did not start`, code: 'NOT_STARTED', help: [`Run \`pnyx-axi serve --board ${id}\``] })
}

// A new board with the next free id, named as given.
export function createBoard({ name }: { name: string }): string {
  const taken = new Set(listBoards().map(b => b.id))
  let n = taken.size + 1

  while (taken.has(`board-${n}`)) {
    n++
  }

  const id = `board-${n}`
  commands.board(['create', id, '--name', name, '--actor', 'web'])

  return id
}

export function renameBoard({ id, name }: { id: string; name: string }): void {
  commands.board(['set', '--board', id, '--name', name, '--actor', 'web'])
}
