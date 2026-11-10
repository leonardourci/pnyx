import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { log, logMode } from '#app/diagnostics.ts'
import { logged } from '#app/log-line.ts'

const run = promisify(execFile)
const KB = 1024
// Every process's id, parent and resident memory in kilobytes, without a header, on macOS and Linux alike.
const LISTING = [
  '-A',
  '-o',
  'pid=,ppid=,rss=',
]

interface AgentIds {
  hydraId: string
  taskId?: string
  sessionId?: string
}

// The agent processes the server runs, with the ids their memory is listed under; a session's id is set once it opens.
const agents = new Map<number, AgentIds>()

export function watchAgent({
  child,
  ids,
}: {
  child: ChildProcess
  ids: AgentIds
}): void {
  const pid = child.pid

  if (pid === undefined) {
    return
  }

  agents.set(
    pid,
    ids,
  )
  child.once(
    'exit',
    () => agents.delete(pid),
  )
}

// The resident memory of each root's whole process tree in one `ps` listing: the root and everything it started.
export function treeMemory({
  listing,
  roots,
}: {
  listing: string
  roots: number[]
}): Map<number, number> {
  const rss = new Map<number, number>()
  const children = new Map<number, number[]>()

  for (const row of listing.split('\n')) {
    const [
      pid,
      parent,
      kb,
    ] = row.trim().split(/\s+/)
      .map(Number)

    if (!Number.isInteger(pid) || !Number.isInteger(parent) || !Number.isFinite(kb)) {
      continue
    }

    rss.set(
      pid!,
      kb! * KB,
    )
    const siblings = children.get(parent!) ?? []
    siblings.push(pid!)
    children.set(
      parent!,
      siblings,
    )
  }

  const trees = new Map<number, number>()

  for (const root of roots.filter(pid => rss.has(pid))) {
    let total = 0
    const left = [root]

    for (let pid = left.pop(); pid !== undefined; pid = left.pop()) {
      total += rss.get(pid) ?? 0
      left.push(...children.get(pid) ?? [])
    }

    trees.set(
      root,
      total,
    )
  }

  return trees
}

// One line listing every agent the server runs with its process tree's resident memory, from one process listing.
// Given a session, a detailed reading of that agent alone, such as at the start and end of its turn.
export async function logAgentMemory({
  sessionId,
  name,
}: {
  sessionId?: string
  name?: string
} = {}): Promise<void> {
  const detailed = sessionId !== undefined
  const watched = [...agents].filter(([
    ,
    ids,
  ]) => !detailed || ids.sessionId === sessionId)

  if (!watched.length || !logged({
    mode: logMode(),
    line: { detailed },
  })) {
    return
  }

  const started = performance.now()
  const { stdout } = await run(
    'ps',
    LISTING,
    { encoding: 'utf8' },
  )
  const trees = treeMemory({
    listing: stdout,
    roots: watched.map(([pid]) => pid),
  })
  log({
    operation: 'agent.memory',
    name,
    detailed,
    ms: performance.now() - started,
    agents: watched.flatMap(([
      pid,
      ids,
    ]) => {
      const rss = trees.get(pid)

      return rss === undefined ? [] : [
        {
          ...ids,
          rss,
        },
      ]
    }),
  })
}
