import { inform } from '#app/command-notices.ts'
import { steeringHeld } from './steering.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { taskDone } from '#tasks/select.ts'
import { TitanError } from '#store/errors.ts'
import { hydraEvent } from '#titan/titan.ts'
import { findCard } from '#tasks/push-rules.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { workerIdentity } from './worker-identity.ts'
import type { Meta } from '#app/command-meta.ts'

export const BROWSER_TOOL = 'browser'

export function toolNames({ names }: { names: string[] }): string[] {
  for (const name of names) {
    if (name !== BROWSER_TOOL) {
      throw new TitanError({
        message: `Invalid tool capability: ${name}`,
        code: 'VALIDATION_ERROR',
        help: ['Use browser; native MCP servers, plugins and apps need no grant'],
      })
    }
  }

  return [...new Set(names)].sort()
}

export async function recordTools({
  hydraId,
  task,
  grant = [],
  revoke = [],
  meta,
}: {
  hydraId: string
  task: string
  grant?: string[]
  revoke?: string[]
  meta: Meta
}) {
  return await withWriter({
    hydraId,
    fn: ({ writer }) => writeTools({
      writer,
      task,
      grant,
      revoke,
      meta,
    }),
  })
}

export function writeTools({
  writer,
  task,
  grant = [],
  revoke = [],
  meta,
}: {
  writer: Writer
  task: string
  grant?: string[]
  revoke?: string[]
  meta: Meta
}) {
  const additions = toolNames({ names: grant })
  const removals = toolNames({ names: revoke })

  const card = findCard({
    state: writer.state,
    ref: task,
  })

  if (card.id !== TITAN_CARD && (card.hidden || taskDone({
    state: writer.state,
    card,
  }))) {
    inform({
      reason: 'Tools changed on a finished or hidden task',
      clear: 'Unhide the task or clear its outcome in the UI',
      task: card.id,
    })
  }

  if (steeringHeld({ card })) {
    inform({
      reason: 'Tools changed while the discussion hold remains',
      clear: 'Release the task hold in the UI',
      task: card.id,
    })
  }

  if (workerIdentity({ actor: meta.actor })) {
    inform({
      task: card.id,
      reason: 'Tools changed by a worker',
      clear: `Revoke browser access from task ${card.id} in the UI`,
    })
  }

  const before = card.tools ?? []
  const after = toolNames({
    names: [
      ...before.filter(name => name === BROWSER_TOOL),
      ...additions,
    ].filter(name => !removals.includes(name)),
  })

  if (JSON.stringify(before) === JSON.stringify(after)) {
    return {
      changed: false,
      tools: after,
    }
  }

  const decision = hydraEvent({
    state: writer.state,
    cardId: card.id,
    meta,
    change: {
      type: 'task.tools',
      data: {
        before,
        after,
      },
    },
  })

  if (!('event' in decision)) {
    return {
      changed: false,
      tools: before,
    }
  }

  writer.append({ event: decision.event })

  return {
    changed: true,
    tools: after,
  }
}

// Only a task's worker asks Titan for another tool; Titan reads its own grants.
export function toolInstructions({
  tools,
  worker,
}: {
  tools: string[]
  worker: boolean
}): string {
  return [
    'Use the harness’s native tools, MCP servers, plugins and apps as configured by the owner.',
    tools.includes(BROWSER_TOOL) ? 'Use chrome-devtools-axi with your own isolated headless browser. Run chrome-devtools-axi stop when finished. Do not control the owner’s browser.' : undefined,
    worker && !tools.includes(BROWSER_TOOL) ? 'For an isolated browser, append needs-you: <request> to worker.log; Titan manages tool grants through the UI.' : undefined,
  ].filter(Boolean).join(' ')
}

export function toolEnvironment({
  env,
  tools,
  hydraId,
  task,
}: {
  env: NodeJS.ProcessEnv
  tools: string[]
  hydraId: string
  task?: string
}): NodeJS.ProcessEnv {
  // A session with no task, as the routine helper, never has a browser.
  if (!task || !tools.includes(BROWSER_TOOL)) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('CHROME_DEVTOOLS_AXI_')))
  }

  return {
    ...env,
    CHROME_DEVTOOLS_AXI_SESSION: `othrys-${hydraId}-${task === TITAN_CARD ? 'hydra' : task}`,
    CHROME_DEVTOOLS_AXI_HEADED: '0',
    CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0',
    CHROME_DEVTOOLS_AXI_BROWSER_URL: '',
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: '',
    CHROME_DEVTOOLS_AXI_PORT: '',
    CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: '',
    CHROME_DEVTOOLS_AXI_WS_HEADERS: '',
  }
}
