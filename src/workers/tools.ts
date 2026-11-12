import { steeringHeld } from './steering.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskDone } from '#tasks/select.ts'
import { HydraError } from '#store/errors.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { findCard } from '#tasks/push-rules.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { requestEnv } from '#app/request-context.ts'
import type { Meta } from '#app/command-meta.ts'

export const BROWSER_TOOL = 'browser'

export function toolNames({ names }: { names: string[] }): string[] {
  for (const name of names) {
    if (name !== BROWSER_TOOL && !/^(mcp|plugin):[^\s\p{Cc}]{1,200}$/u.test(name)) {
      throw new HydraError({
        message: `Invalid tool capability: ${name}`,
        code: 'VALIDATION_ERROR',
        help: ['Use browser, mcp:<configured-name> or plugin:<installed-id>'],
      })
    }
  }

  return [...new Set(names)].sort()
}

export function requireConfigured({
  names,
  offered,
}: {
  names: string[]
  offered: string[]
}): void {
  const missing = names.find(name => !offered.includes(name))

  if (missing) {
    throw new HydraError({
      message: `Tool capability is not configured: ${missing}`,
      code: 'TOOL_UNAVAILABLE',
      help: ['Read the configured names with `pnyx-axi task tools <task> --available`, and revoke a saved grant with `pnyx-axi task tools <task> --revoke <name>`'],
    })
  }
}

export function recordTools({
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
  return withWriter({
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

export function requireToolAuthority({ meta }: { meta: Meta }): void {
  const identity = requestEnv()

  if (identity.PNYX_TASK || identity.PNYX_STEERING_WORKER || identity.PNYX_ACTOR?.startsWith('worker:') || meta.actor.startsWith('worker:')) {
    throw new HydraError({
      message: 'Ask Hydra with task ask for a tool grant',
      code: 'HYDRA_ONLY',
    })
  }
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
  requireToolAuthority({ meta })
  const additions = toolNames({ names: grant })
  const removals = toolNames({ names: revoke })

  const card = findCard({
    state: writer.state,
    ref: task,
  })

  if (card.id !== HYDRA_CARD && (card.hidden || taskDone({
    state: writer.state,
    card,
  }))) {
    throw new HydraError({
      message: 'Reopen this task before changing its tools',
      code: 'CONFLICT',
    })
  }

  if (steeringHeld({ card })) {
    throw new HydraError({
      message: 'Release the discussion hold before changing tools',
      code: 'TASK_HELD',
    })
  }

  const before = card.tools ?? []
  const after = toolNames({
    names: [
      ...before,
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

export function toolInstructions({ tools }: { tools: string[] }): string {
  const browser = tools.includes(BROWSER_TOOL)
    ? 'Use chrome-devtools-axi with your own isolated headless browser. Run chrome-devtools-axi stop when finished. Do not control the owner’s browser.' : ''

  return `Pnyx external tool grants: ${tools.join(', ') || 'none'}. ${browser} For another tool, ask Hydra with pnyx-axi task ask; Hydra grants configured tools with task tools --grant and Pnyx resumes this conversation after the current native work settles.`
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
  if (!tools.includes(BROWSER_TOOL)) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('CHROME_DEVTOOLS_AXI_')))
  }

  return {
    ...env,
    CHROME_DEVTOOLS_AXI_SESSION: `pnyx-${hydraId}-${task ?? 'hydra'}`,
    CHROME_DEVTOOLS_AXI_HEADED: '0',
    CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0',
    CHROME_DEVTOOLS_AXI_BROWSER_URL: '',
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: '',
    CHROME_DEVTOOLS_AXI_PORT: '',
    CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: '',
    CHROME_DEVTOOLS_AXI_WS_HEADERS: '',
  }
}
