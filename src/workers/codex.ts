import { codexProcesses } from './codex-processes.ts'
import { HydraError } from '#store/errors.ts'
import { BROWSER_TOOL } from './tools.ts'
import { log } from '#app/diagnostics.ts'
import { SESSION_TITLE, type SourceNote } from '#tasks/model.ts'
import type { FoundSettings, TranscriptCall, TranscriptRecord, TranscriptReader } from './provider.ts'
import { blockText, foundSettings, injectedDigest, fastSetting, transcriptCall, transcriptString, transcriptText, transcriptTrace, trimmedString } from './transcript-content.ts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Question } from './model.ts'
import { form } from './native-prompts.ts'
import { pnyxHome } from '#store/paths.ts'
import { imageBytes } from './input.ts'
import { nativeSession, type NativeEvent, type NativeSession } from './native-session.ts'
import { compactCommand } from './compact-command.ts'
import { object, count, taskContext, textContent } from './transcript-usage.ts'
import type { TranscriptUsageReader, AskPermission, HostedInput, HostedCompaction, HostedText, HostedTool, HostedThinking, HostedUsage, ModelOption, PermissionDecision, Provider } from './provider.ts'

export type SpawnCodex = ({
  cwd,
  env,
}: {
  cwd: string
  env: NodeJS.ProcessEnv
}) => ChildProcessWithoutNullStreams

type ObjectValue = Record<string, unknown>
// JSON-RPC's code for a method the app-server does not have.
const METHOD_NOT_FOUND = -32601
// Codex's never with full access is Pnyx's bypass permissions.
const NEVER = 'never', ON_REQUEST = 'on-request', BYPASS = 'bypassPermissions'
const FULL_ACCESS = 'danger-full-access', WORKSPACE_WRITE = 'workspace-write'

// The server requests Pnyx answers, each shown to the owner as this tool.
const TOOLS: Record<string, string> = {
  'item/commandExecution/requestApproval': 'Command',
  'item/fileChange/requestApproval': 'File change',
  'item/permissions/requestApproval': 'Turn permissions',
  'item/tool/requestUserInput': 'Question',
  'mcpServer/elicitation/request': 'MCP input',
}
const VIEW_ITEMS = [
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'functionCallOutput',
  'plan',
  'reasoning',
  'imageView',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
]
const ASKS = Object.keys(TOOLS)
const REQUEST_TIMEOUT_MS = 30_000
// Opening a thread first starts every configured MCP server and plugin, which can take minutes.
const OPEN_TIMEOUT_MS = 300_000
const TOOL_LABELS: Record<string, string> = {
  commandExecution: 'Shell',
  mcpToolCall: 'MCP tool',
  dynamicToolCall: 'Tool',
  collabAgentToolCall: 'Agent',
  webSearch: 'Web search',
}

// Items that run while the turn waits on them, such as a shell command or a subagent.
const TOOL_ITEMS = [
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
]
// Protocol ids a person never needs to judge a request.
const HIDDEN = [
  'threadId',
  'turnId',
  'itemId',
  'approvalId',
  'startedAtMs',
]

// Codex's own request fields plus the neutral `display` (its command without the shell wrapper) and `paths`.
function approvalInput({
  params,
  item,
  method,
}: {
  params: ObjectValue
  item?: ObjectValue
  method: string
}): ObjectValue {
  const shown = Object.fromEntries(Object.entries(params).filter(([key]) => !HIDDEN.includes(key)))
  const actions = Array.isArray(params.commandActions) ? params.commandActions : []
  const display = actions.length === 1 ? object({ value: actions[0] }).command : undefined
  const changes = item?.changes ?? params.changes
  const paths = Array.isArray(changes)
    ? changes.flatMap(change => {
      const path = object({ value: change }).path

      return typeof path === 'string' ? [path] : []
    })
    : undefined

  return {
    ...shown,
    ...(method === 'item/permissions/requestApproval' ? { scope: 'turn' } : {}),
    ...(item?.changes ? { changes: item.changes } : {}),
    ...(typeof display === 'string' ? { display } : {}),
    ...(paths ? { paths } : {}),
  }
}

// request_user_input questions; one without options takes typed text only.
function userQuestions({ value }: { value: unknown }): (Question & { id: string })[] {
  return (Array.isArray(value) ? value : []).flatMap(raw => {
    const q = object({ value: raw })
    const options = (Array.isArray(q.options) ? q.options : []).map(o => object({ value: o })).filter(o => typeof o.label === 'string')

    return typeof q.id === 'string' && typeof q.question === 'string'
      ? [
        {
          id: q.id,
          question: q.question,
          ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
          ...(q.isSecret === true ? { secret: true } : {}),
          options: options.map(o => ({
            label: o.label as string,
            ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
          })),
        },
      ]
      : []
  })
}

// Every way Codex names a command, so Stop can find the process whichever the shell was started with.
function commandLines({ item }: { item: ObjectValue }): string[] {
  const lines: string[] = []

  for (const action of Array.isArray(item.commandActions) ? item.commandActions : []) {
    const { command } = object({ value: action })

    if (typeof command === 'string') {
      lines.push(command)
    }
  }

  const value = item.command

  if (typeof value === 'string') {
    lines.push(value)
  } else if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
    lines.push(value.join(' '))
  }

  return lines
}

function connection({
  child,
  command = () => {},
}: {
  child: ChildProcessWithoutNullStreams
  command?({
    id,
    commands,
    completed,
  }: {
    id: string
    commands: string[]
    completed: boolean
  }): void
}) {
  let permission: AskPermission | undefined, activeThread: string | undefined
  let emit: ({ event }: { event: NativeEvent }) => void = () => {}
  const approvals = new Map<string | number, {
    abort: AbortController
    thread: unknown
    turn: unknown
  }>()
  const items = new Map<string, ObjectValue>()
  const background = new Map<string, {
    id: string
    type: string
  }>()
  const unknownItems = new Map<string, string>()

  const observeWork = ({
    params,
    completed,
  }: {
    params: ObjectValue
    completed: boolean
  }) => {
    if (params.threadId !== activeThread) {
      return
    }

    const item = object({ value: params.item })
    const unknownId = String(item.id ?? item.type)
    let unknownWork: string | undefined

    if (completed) {
      unknownItems.delete(unknownId)
    }

    if (item.type === 'collabAgentToolCall') {
      const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      const states = object({ value: item.agentsStates })

      for (const receiver of receivers) {
        if (typeof receiver !== 'string') {
          unknownWork = 'Codex reported an unrecognized child agent'
          continue
        }

        const status = object({ value: states[receiver] }).status
        const id = `agent:${receiver}`

        if (status === 'shutdown' || status === 'notFound') {
          background.delete(id)
        } else {
          // A completed child turn can still own native queued or background work.
          background.set(
            id,
            {
              id,
              type: 'agent',
            },
          )
        }
      }

      if (receivers.length === 0 && item.status !== 'failed') {
        unknownWork = 'Codex did not identify the child agents of a collaboration call'
      }
    } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
      const id = `agent:${item.agentThreadId}`
      background.set(
        id,
        {
          id,
          type: 'agent',
        },
      )
    } else if (item.type === 'commandExecution' && completed && typeof item.id === 'string') {
      const id = `command:${item.id}`

      if (typeof item.exitCode === 'number' || item.status === 'failed' || item.status === 'declined') {
        background.delete(id)
      } else if (typeof item.processId === 'string') {
        background.set(
          id,
          {
            id,
            type: 'command',
          },
        )
      } else if (item.status !== 'completed') {
        unknownWork = 'Codex did not report whether a command stopped'
      }
    } else if (!completed && (typeof item.type !== 'string' || ![
      ...VIEW_ITEMS,
      ...TOOL_ITEMS,
      'fileChange',
      'imageGeneration',
      'sleep',
    ].includes(item.type))) {
      unknownWork = `Codex reported an unrecognized native item: ${String(item.type)}`
    }

    if (unknownWork) {
      unknownItems.set(
        unknownId,
        unknownWork,
      )
    }

    if (unknownItems.size) {
      emit({
        event: {
          type: 'background',
          background: {
            knowledge: 'unknown',
            reason: [...unknownItems.values()].join('; '),
          },
        },
      })
    } else {
      emit({
        event: {
          type: 'background',
          background: {
            knowledge: 'known',
            tasks: [...background.values()],
          },
        },
      })
    }
  }

  let next = 0, stopped = false, compacted = false, failure: Error | undefined, stderr = ''
  const pending = new Map<number, {
    resolve({ value }: { value: ObjectValue }): void
    reject({ error }: { error: Error }): void
  }>()
  let end: ({ error }: { error: Error }) => void = () => {}
  const ended = new Promise<Error>(resolve => {
    end = ({ error }) => resolve(error)
  })
  const events: ObjectValue[] = []
  let wake: (() => void) | undefined
  const lines = createInterface({ input: child.stdout })

  const stop = ({ error }: { error: Error }) => {
    if (failure) {
      return
    }

    failure = error

    for (const { abort } of approvals.values()) {
      abort.abort()
    }

    approvals.clear()
    end({ error })

    for (const request of pending.values()) {
      request.reject({ error })
    }

    pending.clear()
    wake?.()
  }

  const write = ({ message }: { message: ObjectValue }) => {
    if (failure) {
      throw failure
    }

    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  child.stderr.on(
    'data',
    data => {
      stderr = (stderr + String(data)).slice(-2000)
    },
  )
  child.stdin.on(
    'error',
    error => stop({ error }),
  )
  child.on(
    'error',
    error => stop({ error }),
  )
  child.on(
    'exit',
    (
      code,
      signal,
    ) => stop({ error: new Error(`Codex app-server exited (${signal ?? code})${stderr ? `: ${stderr}` : ''}`) }),
  )
  lines.on(
    'line',
    line => {
      try {
        const message = object({ value: JSON.parse(line) })

        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            const id = message.id

            if ((typeof id !== 'string' && typeof id !== 'number') || approvals.has(id)) {
              return
            }

            if (!ASKS.includes(message.method)) {
              write({
                message: {
                  id,
                  error: {
                    code: -32601,
                    message: 'Pnyx cannot answer this request yet',
                  },
                },
              })

              return
            }

            const params = object({ value: message.params })
            const abort = new AbortController()
            approvals.set(
              id,
              {
                abort,
                thread: params.threadId,
                turn: params.turnId,
              },
            )
            const item = typeof params.itemId === 'string' ? items.get(params.itemId) : undefined
            const method = message.method
            const asked = method === 'item/tool/requestUserInput'
              ? userQuestions({ value: params.questions })
              : []
            const elicitation = method === 'mcpServer/elicitation/request'
            const fields = elicitation
              ? form({
                payload: {
                  requested_schema: params.requestedSchema,
                  mode: params.mode,
                },
              })
              : undefined
            const input = approvalInput({
              params,
              item,
              method,
            })
            const nativeId = `${typeof id}:${id}`
            const answer = permission && params.threadId === activeThread ? permission({
              id: nativeId,
              tool: TOOLS[method]!,
              input,
              signal: abort.signal,
              ...(typeof params.reason === 'string' ? { description: params.reason } : {}),
              ...(asked.length ? { questions: asked } : {}),
              ...(fields ? { form: fields } : {}),
            }) : Promise.resolve({
              behavior: 'deny' as const,
              message: '',
            })

            const respond = ({ decision }: { decision: PermissionDecision }) => {
              if (!failure && approvals.get(id)?.abort === abort) {
                approvals.delete(id)
                const allow = decision.behavior === 'allow'
                const requested = object({ value: params.permissions })
                const permissions = Object.fromEntries(
                  Object.entries(requested).filter(([
                    , value,
                  ]) => value !== null),
                )
                const result = method === 'item/permissions/requestApproval'
                  ? {
                    permissions: allow ? permissions : {},
                    scope: 'turn',
                  }
                  : method === 'item/tool/requestUserInput'
                    ? {
                      answers: allow
                        ? Object.fromEntries(asked.map((
                          q,
                          i,
                        ) => [
                          q.id,
                          { answers: decision.answers?.[i] ?? [] },
                        ]))
                        : {},
                    }
                    : elicitation
                      ? allow ? {
                        action: 'accept',
                        content: decision.values ?? {},
                      } : { action: 'decline' }
                      : { decision: allow ? 'accept' : 'decline' }
                write({
                  message: {
                    id,
                    result,
                  },
                })
                emit({
                  event: {
                    type: 'answer-submitted',
                    id: nativeId,
                  },
                })
              }
            }

            void answer.then(
              decision => respond({ decision }),
              () => respond({
                decision: {
                  behavior: 'deny',
                  message: '',
                },
              }),
            )
          } else if (message.method === 'serverRequest/resolved' || message.method === 'turn/completed') {
            const params = object({ value: message.params })
            const turn = object({ value: params.turn })

            for (const [
              id,
              request,
            ] of approvals) {
              if (request.thread === params.threadId && (message.method === 'serverRequest/resolved' ? id === params.requestId : request.turn === turn.id)) {
                approvals.delete(id)
                request.abort.abort()
              }
            }

            if (message.method !== 'turn/completed') {
              return
            }

            items.clear()
            events.push(params)
            wake?.()
          } else if (message.method === 'thread/tokenUsage/updated' || message.method === 'account/rateLimits/updated' || message.method === 'turn/started') {
            events.push({
              ...object({ value: message.params }),
              method: message.method,
            })
            wake?.()
          } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/completed') {
            const params = object({ value: message.params })

            if (message.method === 'item/completed') {
              observeWork({
                params,
                completed: true,
              })
            }

            const item = object({ value: params.item })

            if (item.type === 'commandExecution' && typeof item.id === 'string') {
              command({
                id: item.id,
                commands: commandLines({ item }),
                completed: true,
              })
            }

            const toolDone = message.method === 'item/completed' && TOOL_ITEMS.includes(String(item.type))

            if (message.method === 'item/agentMessage/delta' || item.type === 'agentMessage' || item.type === 'reasoning' || toolDone) {
              events.push({
                ...params,
                method: message.method,
              })
              wake?.()
            } else if (item.type === 'contextCompaction') {
              compacted = true
              events.push({
                ...params,
                method: message.method,
              })
              wake?.()
            }
          } else if (message.method === 'item/started') {
            const params = object({ value: message.params })
            observeWork({
              params,
              completed: false,
            })
            const item = object({ value: params.item })

            if (item.type === 'commandExecution' && typeof item.id === 'string') {
              command({
                id: item.id,
                commands: commandLines({ item }),
                completed: false,
              })
            }

            if (item.type === 'fileChange' && typeof item.id === 'string') {
              items.set(
                item.id,
                item,
              )
            }

            if (item.type === 'contextCompaction' || item.type === 'reasoning' || TOOL_ITEMS.includes(String(item.type))) {
              events.push({
                ...params,
                method: message.method,
              })
              wake?.()
            }
          }
        } else if (typeof message.id === 'number') {
          const request = pending.get(message.id)
          pending.delete(message.id)

          if (message.error) {
            const error = object({ value: message.error })
            request?.reject({
              error: Object.assign(
                new Error(String(error.message ?? 'Codex request failed')),
                { code: error.code },
              ),
            })
          } else {
            request?.resolve({ value: object({ value: message.result }) })
          }
        }
      } catch (error) {
        stop({ error: error as Error })
      }
    },
  )
  lines.on(
    'close',
    () => stop({ error: new Error('Codex app-server closed its output') }),
  )

  return {
    ended,
    permissions({
      ask,
      thread,
      events,
    }: {
      ask: AskPermission
      thread: string
      events({ event }: { event: NativeEvent }): void
    }) {
      permission = ask
      activeThread = thread
      emit = events
    },
    async request({
      method,
      params,
      timeout = REQUEST_TIMEOUT_MS,
    }: {
      method: string
      params: ObjectValue
      timeout?: number
    }): Promise<ObjectValue> {
      const id = ++next
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        return await new Promise<ObjectValue>((
          resolve,
          reject,
        ) => {
          timer = setTimeout(
            () => {
              pending.delete(id)
              reject(new Error(`Codex ${method} timed out`))
            },
            timeout,
          ).unref()
          pending.set(
            id,
            {
              resolve: ({ value }) => resolve(value),
              reject: ({ error }) => reject(error),
            },
          )

          try {
            write({
              message: {
                id,
                method,
                params,
              },
            })
          } catch (error) {
            pending.delete(id)
            reject(error)
          }
        })
      } finally {
        clearTimeout(timer)
      }
    },
    compacted() {
      const was = compacted
      compacted = false

      return was
    },
    notify({ method }: { method: string }) {
      write({ message: { method } })
    },
    async* completed({
      threadId,
      turnId,
      manualCompact = false,
      started,
    }: {
      threadId: string
      turnId?: string
      manualCompact?: boolean
      started?({ id }: { id: string }): Promise<void>
    }): AsyncGenerator<
      HostedText | HostedTool | HostedThinking | HostedUsage
      | HostedCompaction | { turn: ObjectValue }
    > {
      let compactId: string | undefined

      for (;;) {
        if (failure) {
          throw failure
        }

        const event = events.shift()

        if (event) {
          const turn = object({ value: event.turn })

          // The account's windows are not about one thread.
          if (event.method === 'account/rateLimits/updated') {
            yield codexLimits({ rateLimits: event.rateLimits })
            continue
          }

          if (event.threadId !== threadId) {
            continue
          }

          // The last request's total is the context in use.
          if (event.method === 'thread/tokenUsage/updated') {
            const usage = object({ value: event.tokenUsage })
            const used = object({ value: usage.last }).totalTokens
            const window = usage.modelContextWindow
            yield {
              type: 'usage',
              ...(typeof used === 'number' ? { used } : {}),
              ...(typeof window === 'number' ? { window } : {}),
            }
            continue
          }

          if (event.method === 'turn/started') {
            if (!turnId && typeof turn.id === 'string') {
              turnId = turn.id
              await started?.({ id: turnId })
            }

            continue
          }

          if (turn.id === turnId) {
            if (manualCompact) {
              compacted = turn.status === 'completed'
            }

            if (compactId) {
              yield {
                type: 'compaction',
                id: compactId,
                trigger: manualCompact ? 'manual' : 'auto',
                state: turn.status === 'interrupted' ? 'cancelled' : turn.status === 'completed' ? 'done' : 'failed',
                ...(turn.status === 'failed' ? { error: String(object({ value: turn.error }).message ?? 'Compaction failed') } : {}),
              }
            }

            yield { turn }

            return
          }

          if (event.turnId === turnId) {
            const item = object({ value: event.item })
            const toolEvent = event.method === 'item/started' || event.method === 'item/completed'

            if (toolEvent && item.type === 'contextCompaction' && typeof item.id === 'string') {
              if (event.method === 'item/started') {
                compactId = item.id
                yield {
                  type: 'compaction',
                  id: item.id,
                  trigger: manualCompact ? 'manual' : 'auto',
                  state: 'running',
                }
              } else if (!manualCompact) {
                compactId = undefined
                yield {
                  type: 'compaction',
                  id: item.id,
                  trigger: 'auto',
                  state: 'done',
                }
              }

              continue
            }

            if (toolEvent && item.type === 'reasoning' && typeof item.id === 'string') {
              yield {
                type: 'thinking',
                id: item.id,
                running: event.method === 'item/started',
              }
              continue
            }

            if (toolEvent && TOOL_ITEMS.includes(String(item.type)) && typeof item.id === 'string') {
              yield {
                type: 'tool',
                id: item.id,
                tool: typeof item.name === 'string' ? item.name : TOOL_LABELS[String(item.type)],
                running: event.method === 'item/started',
              }
              continue
            }

            const id = event.method === 'item/agentMessage/delta' ? event.itemId : item.id
            const text = event.method === 'item/agentMessage/delta' ? event.delta : item.text

            if (typeof id === 'string' && typeof text === 'string') {
              yield {
                type: 'text',
                id,
                text,
                append: event.method === 'item/agentMessage/delta',
              }
            }
          }
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
          wake = undefined
        }
      }
    },
    close() {
      if (stopped) {
        return
      }

      stopped = true
      stop({ error: new Error('Codex app-server closed') })
      lines.close()
      child.stdin.end()
      child.kill()
      const kill = setTimeout(
        () => child.kill('SIGKILL'),
        2000,
      ).unref()
      child.once(
        'exit',
        () => clearTimeout(kill),
      )
    },
  }
}

const initialize = ({ rpc }: { rpc: ReturnType<typeof connection> }) => rpc
  .request({
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'pnyx',
        version: '0.0.0',
      },
      capabilities: null,
    },
  })
  .then(() => rpc.notify({ method: 'initialized' }))

const serviceTier = ({ fast }: { fast?: string }) =>
  fast !== undefined ? { serviceTier: fast === 'true' ? 'fast' : 'default' } : {}

// An agent that asks writes only in its folder and Pnyx's home; network stays on so pnyx-axi reaches the server.
const sandboxPolicy = ({
  mode,
  env,
}: {
  mode: string
  env: NodeJS.ProcessEnv
}) => mode === NEVER
  ? { type: 'dangerFullAccess' }
  : {
    type: 'workspaceWrite',
    writableRoots: [env.PNYX_HOME || pnyxHome()],
    networkAccess: true,
  }

// A shell_environment_policy that inherits only core variables would drop Pnyx's own and its git settings, so they are set explicitly.
const pnyxShellEnvironment = ({ env }: { env: NodeJS.ProcessEnv }) => Object.fromEntries(Object
  .entries(env)
  .filter(([
    name,
    value,
  ]) => (name.startsWith('PNYX_') || name.startsWith('CHROME_DEVTOOLS_AXI_') || name.startsWith('GIT_CONFIG_')) && value !== undefined)
  .map(([
    name,
    value,
  ]) => [
    `shell_environment_policy.set.${name}`,
    value,
  ]))

// Codex reports its account's windows by length: the five-hour one is the session, the seven-day one the week.
const windowLabel = ({ minutes }: { minutes: number }) => {
  if (minutes <= 300) {
    return 'session'
  }

  if (minutes >= 10_080) {
    return 'week'
  }

  return `${Math.round(minutes / 60)}h`
}

export function codexLimits({ rateLimits }: { rateLimits: unknown }): HostedUsage {
  const limits = object({ value: rateLimits })

  return {
    type: 'usage',
    ...(typeof limits.planType === 'string' ? { plan: limits.planType } : {}),
    limits: [
      limits.primary,
      limits.secondary,
    ].flatMap(value => {
      const window = object({ value })
      const minutes = window.windowDurationMins
      const label = typeof minutes === 'number' ? windowLabel({ minutes }) : undefined

      return label && typeof window.usedPercent === 'number' ? [
        {
          label,
          used: Math.round(window.usedPercent),
          ...(typeof window.resetsAt === 'number'
            ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
        },
      ] : []
    }),
  }
}

async function readConfig({
  rpc,
  cwd,
}: {
  rpc: ReturnType<typeof connection>
  cwd: string
}): Promise<Record<string, unknown>> {
  const settings = await rpc.request({
    method: 'config/read',
    params: {
      cwd,
      includeLayers: false,
    },
  })

  if (!settings.config || typeof settings.config !== 'object') {
    throw new Error('Codex tool configuration could not be read')
  }

  return object({ value: settings.config })
}

// Servers and plugins the owner turned off stay off the catalog, so a grant cannot turn them on.
function codexCatalog({ config }: { config: Record<string, unknown> }): string[] {
  const enabled = ({ entries }: { entries: Record<string, unknown> }) => Object.keys(entries)
    .filter(name => name !== '_default' && object({ value: entries[name] }).enabled !== false)

  return [
    BROWSER_TOOL,
    ...enabled({ entries: object({ value: config.mcp_servers }) }).map(name => `mcp:${name}`),
    ...enabled({ entries: object({ value: config.plugins }) }).map(name => `plugin:${name}`),
  ].sort()
}

async function scopedConfig({
  rpc,
  cwd,
  grants = [],
  routine = false,
}: {
  rpc: ReturnType<typeof connection>
  cwd: string
  grants?: string[]
  routine?: boolean
}): Promise<Record<string, unknown>> {
  const config = await readConfig({
    rpc,
    cwd,
  })
  const disabledSkills: {
    path: string
    enabled: false
  }[] = []

  if (routine) {
    const skills = await rpc.request({
      method: 'skills/list',
      params: { cwds: [cwd] },
    })

    if (!Array.isArray(skills.data)) {
      throw new Error('Routine helper skill catalog could not be read')
    }

    for (const value of skills.data) {
      const row = object({ value })

      if (!Array.isArray(row.skills)) {
        throw new Error('Routine helper skill catalog is invalid')
      }

      for (const value of row.skills) {
        const skill = object({ value })

        if (typeof skill.path !== 'string') {
          throw new Error('Routine helper skill path is invalid')
        }

        disabledSkills.push({
          path: skill.path,
          enabled: false,
        })
      }
    }
  }

  const servers = object({ value: config.mcp_servers })
  const plugins = object({ value: config.plugins })
  const catalog = codexCatalog({ config })

  for (const name of grants) {
    if (!catalog.includes(name)) {
      throw new HydraError({
        message: `Tool capability is not configured for this Codex login: ${name}; configure it or run \`pnyx-axi task tools <task> --revoke ${name}\``,
        code: 'TOOL_UNAVAILABLE',
      })
    }
  }

  // Codex splits a dotted key on every dot and keeps its quotes, so names go in nested tables.
  const serverOverrides: Record<string, { enabled: boolean }> = {}
  const pluginOverrides: Record<string, unknown> = { _default: { enabled: false } }
  const overrides: Record<string, unknown> = {
    'features.apps': false,
    'features.plugins': grants.some(name => name.startsWith('plugin:')),
    mcp_servers: serverOverrides,
    plugins: pluginOverrides,
  }

  if (routine) {
    Object.assign(
      overrides,
      {
        'skills.config': disabledSkills,
        'skills.bundled.enabled': false,
        'skills.include_instructions': false,
        'features.sleep_tool': false,
        'features.default_mode_request_user_input': false,
        'tools.update_plan.enabled': false,
        web_search: 'disabled',
      },
    )
  }

  for (const name of Object.keys(servers)) {
    serverOverrides[name] = { enabled: grants.includes(`mcp:${name}`) }
  }

  for (const name of Object.keys(plugins).filter(name => name !== '_default')) {
    const enabled = grants.includes(`plugin:${name}`)
    const bundled = Object.keys(object({ value: object({ value: plugins[name] }).mcp_servers }))
    pluginOverrides[name] = {
      enabled,
      mcp_servers: Object.fromEntries(bundled.map(server => [
        server,
        { enabled },
      ])),
    }
  }

  return overrides
}

export function codexProvider({
  spawnCodex = ({
    cwd,
    env,
  }) => spawn(
    'codex',
    [
      'app-server',
      '--listen',
      'stdio://',
    ],
    {
      cwd,
      env,
      stdio: 'pipe',
      // Its own process group, so a later start can stop it together with the tools it ran.
      detached: true,
    },
  ),
}: { spawnCodex?: SpawnCodex }): Provider {
  return {
    compact: true,
    async toolCatalog({
      cwd,
      env,
    }) {
      const rpc = connection({
        child: spawnCodex({
          cwd,
          env,
        }),
      })

      try {
        await initialize({ rpc })

        return codexCatalog({
          config: await readConfig({
            rpc,
            cwd,
          }),
        })
      } finally {
        rpc.close()
      }
    },
    async models({
      cwd,
      env,
    }) {
      const rpc = connection({
        child: spawnCodex({
          cwd,
          env,
        }),
      })

      try {
        await initialize({ rpc })
        const models: ModelOption[] = []
        let cursor: string | undefined

        do {
          const page = await rpc.request({
            method: 'model/list',
            params: { ...(cursor ? { cursor } : {}) },
          })

          for (const raw of Array.isArray(page.data) ? page.data : []) {
            const model = object({ value: raw })

            if (typeof model.model === 'string' && typeof model.displayName === 'string') {
              const fast = Array.isArray(model.additionalSpeedTiers) && model.additionalSpeedTiers.includes('fast')

              models.push({
                value: model.model,
                label: model.displayName,
                ...(model.isDefault === true ? { isDefault: true } : {}),
                ...(typeof model.defaultReasoningEffort === 'string' ? { defaultEffort: model.defaultReasoningEffort } : {}),
                ...(fast ? { fast: true as const } : {}),
              })
            }
          }

          cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
        } while (cursor)

        return models
      } finally {
        rpc.close()
      }
    },
    async defaults({
      cwd,
      env,
      models,
    }) {
      const rpc = connection({
        child: spawnCodex({
          cwd,
          env,
        }),
      })

      try {
        const read = initialize({ rpc }).then(() => rpc.request({
          method: 'config/read',
          params: { cwd },
        }))
        // A Codex that cannot start or read its config still offers the stored list, with its own defaults.
        const config = object({ value: (await read.catch((): ObjectValue => ({}))).config })
        const approval = config.approval_policy
        // Every Pnyx mode brings its own sandbox, so a never without full access is named on-request, never wider.
        const defaultMode = approval === NEVER && config.sandbox_mode === FULL_ACCESS
          ? BYPASS
          : typeof approval === 'string' && approval !== NEVER ? approval : ON_REQUEST

        return models.map(model => {
          const effort = config.model_reasoning_effort ?? model.defaultEffort

          return {
            ...model,
            ...(typeof effort === 'string' ? { defaultEffort: effort } : {}),
            defaultMode,
          }
        })
      } finally {
        rpc.close()
      }
    },
    // ponytail: Codex has no per-command allow list here, so `allow` is unused and a Codex Hydra or worker asks in its chat.
    async open({
      cwd,
      agent,
      settings,
      env,
      signal,
      instructions,
      outputSchema,
      toolScope,
      capabilities = [],
      context,
      spawned,
    }) {
      let deferredInterrupt: {
        done: Promise<void>
        resolve(): void
        reject({ error }: { error: unknown }): void
      } | undefined
      const child = spawnCodex({
        cwd,
        env,
      })
      spawned?.({ child })

      const processes = codexProcesses({ pid: child.pid })
      const rpc = connection({
        child,
        command: processes.command,
      })

      const close = () => {
        deferredInterrupt?.reject({ error: new Error('The Codex session closed before it could be interrupted') })
        deferredInterrupt = undefined
        signal.removeEventListener(
          'abort',
          close,
        )
        rpc.close()
      }

      signal.addEventListener(
        'abort',
        close,
        { once: true },
      )

      if (signal.aborted) {
        close()
      }

      try {
        await initialize({ rpc })
        const options = { ...settings }
        // Bypass permissions is Codex's never: no approvals, full access.
        const policy = () => (options.mode === BYPASS ? NEVER : options.mode ?? '')
        const config: Record<string, unknown> = {
          ...pnyxShellEnvironment({ env }),
          'features.default_mode_request_user_input': true,
        }

        Object.assign(
          config,
          await scopedConfig({
            rpc,
            cwd,
            grants: capabilities,
            routine: toolScope === 'routine',
          }),
        )

        const result = await rpc.request({
          method: agent ? 'thread/resume' : 'thread/start',
          timeout: OPEN_TIMEOUT_MS,
          params: {
            ...(agent ? { threadId: agent.sessionId } : {}),
            cwd,
            // Lets a worker ask the owner with request_user_input outside plan mode.
            config,
            ...(instructions ? { developerInstructions: instructions } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...serviceTier({ fast: options.fast }),
            ...(policy()
              ? {
                approvalPolicy: policy(),
                sandbox: policy() === NEVER ? FULL_ACCESS : WORKSPACE_WRITE,
              }
              : {}),
          },
        })
        const thread = object({ value: result.thread })

        if (typeof thread.id !== 'string' || !thread.id || (agent && thread.id !== agent.sessionId)) {
          throw new Error('Codex returned an unexpected thread id')
        }

        const id = thread.id
        let turnId: string | undefined, interrupted = false
        let stoppedCommands: Promise<number[]> | undefined
        let continuation: HostedInput | undefined
        let latestSteering: HostedInput | undefined
        const carried: HostedInput[] = []
        let publish: Parameters<NativeSession['run']>[0]['emit'] | undefined

        const stopTurn = async () => {
          const early = processes.capture()
          await rpc.request({
            method: 'turn/interrupt',
            params: {
              threadId: id,
              turnId,
            },
          })

          // Cleanup runs after the interrupt is accepted, so a slow process table never delays Stop.
          stoppedCommands = (async () => {
            const cleanups = [
              await early,
              await processes.capture(),
            ]
            const stopped = await Promise.all(cleanups.map(cleanup => cleanup()))

            return [...new Set(stopped.flat())]
          })()
        }

        const interruptStartedTurn = async () => {
          const waiting = deferredInterrupt

          if (!waiting) {
            return
          }

          deferredInterrupt = undefined

          try {
            await stopTurn()
            waiting.resolve()
          } catch (error) {
            interrupted = false
            waiting.reject({ error })
          }
        }

        const native: NativeSession = {
          id,
          ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
          async* run({
            input,
            permission,
            emit,
          }) {
            publish = emit
            rpc.permissions({
              ask: permission,
              thread: id,
              events: emit,
            })
            const messages = input[Symbol.asyncIterator]()

            // Raced only while waiting for a message, so a closed app-server never goes unhandled.
            const appServerClosed = async (): Promise<never> => {
              throw await rpc.ended
            }

            // ponytail: Codex has no session hooks here, so the context leads the first turn and the turn after a compaction; a compaction mid-turn waits for the next turn.
            let fresh = true
            // One read of the next message is always open, so a message that arrives mid-turn joins the running turn.
            let incoming = messages.next()
            let inputDone = false
            // Messages that could not join the running turn, because it was ending or being stopped; each opens a turn of its own.

            const turnInput = ({
              text,
              message,
            }: {
              text: string
              message: HostedInput
            }) => [
              {
                type: 'text',
                text,
                text_elements: [],
              },
              ...message.images.map(image => {
                imageBytes({ image })

                return {
                  type: 'localImage',
                  path: image.path,
                }
              }),
            ]

            for (;;) {
              let message = continuation ?? carried.shift()
              continuation = undefined

              if (message === undefined && inputDone) {
                return
              }

              if (message === undefined) {
                const next = await Promise.race([
                  incoming,
                  appServerClosed(),
                ])

                if (next.done) {
                  return
                }

                message = next.value
                incoming = messages.next()
              }

              processes.begin()
              stoppedCommands = undefined
              latestSteering = undefined
              const said = message.text
              const inputIds = [message.id]
              emit({
                event: {
                  type: 'input',
                  receipt: {
                    inputId: message.id,
                    phase: 'taken',
                  },
                },
              })
              const manualCompact = compactCommand({ text: said })
              let compacted = false

              if (context && !manualCompact) {
                compacted = rpc.compacted()
              }

              const text = context && !manualCompact && (compacted || fresh) ? `${await context({ compacted })}\n\n${said}` : said

              if (!manualCompact) {
                fresh = false
              }

              if (manualCompact && said.trim() !== '/compact') {
                yield 'working'
                const compactId = randomUUID()
                yield {
                  type: 'compaction',
                  id: compactId,
                  trigger: 'manual',
                  state: 'failed',
                  error: 'Codex compact does not accept instructions. Send /compact on its own.',
                }
                emit({
                  event: {
                    type: 'result',
                    turn: randomUUID(),
                    inputIds,
                    status: 'failed',
                    queued: carried.length,
                    error: 'Codex compact does not accept instructions',
                  },
                })
                yield 'finished'
                continue
              }

              let result: ObjectValue

              try {
                result = await rpc.request({
                  method: manualCompact ? 'thread/compact/start' : 'turn/start',
                  params: manualCompact ? { threadId: id } : {
                    threadId: id,
                    ...(outputSchema ? { outputSchema } : {}),
                    input: turnInput({
                      text,
                      message,
                    }),
                    ...(options.model ? { model: options.model } : {}),
                    ...serviceTier({ fast: options.fast }),
                    ...(options.effort ? { effort: options.effort } : {}),
                    ...(policy()
                      ? {
                        approvalPolicy: policy(),
                        sandboxPolicy: sandboxPolicy({
                          mode: policy(),
                          env,
                        }),
                      }
                      : {}),
                  },
                })
              } catch (error) {
                if (!manualCompact || (error as { code?: unknown }).code !== METHOD_NOT_FOUND) {
                  // Codex answered with an error, so it did not take this input.
                  for (const inputId of inputIds) {
                    emit({
                      event: {
                        type: 'input',
                        receipt: {
                          inputId,
                          phase: 'refused',
                        },
                      },
                    })
                  }

                  throw error
                }

                yield 'working'
                yield {
                  type: 'compaction',
                  id: randomUUID(),
                  trigger: 'manual',
                  state: 'failed',
                  error: `Codex cannot compact this session: ${(error as Error).message}`,
                  unsupported: true,
                }
                emit({
                  event: {
                    type: 'result',
                    turn: randomUUID(),
                    inputIds,
                    status: 'failed',
                    queued: carried.length,
                    error: 'Codex cannot compact this session',
                  },
                })
                yield 'finished'
                continue
              }

              const turn = object({ value: result.turn })

              if (!manualCompact && typeof turn.id !== 'string') {
                throw new Error('Codex returned no turn id')
              }

              turnId = manualCompact ? undefined : turn.id as string
              let runningTurn = turnId
              let resultId = turnId ?? randomUUID()
              emit({
                event: {
                  type: 'turn-started',
                  turn: resultId,
                },
              })
              emit({
                event: {
                  type: 'input',
                  receipt: {
                    inputId: message.id,
                    phase: 'confirmed',
                    turn: resultId,
                  },
                },
              })

              // A stop that came before Codex named the turn applies now.
              if (turnId) {
                await interruptStartedTurn()
              }

              const events = rpc.completed({
                threadId: id,
                turnId: runningTurn,
                manualCompact,
                started: async ({ id }) => {
                  turnId = id
                  runningTurn = id
                  resultId = id
                  emit({
                    event: {
                      type: 'input',
                      receipt: {
                        inputId: message.id,
                        phase: 'confirmed',
                        turn: resultId,
                      },
                    },
                  })
                  await interruptStartedTurn()
                },
              })[Symbol.asyncIterator]()
              // Compaction must receive its turn id even when the output consumer pauses.
              const compactEvent = manualCompact ? events.next() : undefined
              yield 'working'
              let terminal: Record<string, unknown> | undefined
              let pendingEvent = compactEvent ?? events.next()
              type Arrival = {
                kind: 'event'
                result: Awaited<typeof pendingEvent>
              } | {
                kind: 'message'
                result: Awaited<typeof incoming>
              }
              const eventArrives = async (): Promise<Arrival> => ({
                kind: 'event',
                result: await pendingEvent,
              })
              const messageArrives = async (): Promise<Arrival> => ({
                kind: 'message',
                result: await incoming,
              })
              // One wrapper per pending read, so a turn's many events do not pile up waiters on the message read.
              let eventArrival = eventArrives()
              let messageArrival = messageArrives()

              for (;;) {
                const arrivals = [eventArrival]

                if (!inputDone) {
                  arrivals.push(messageArrival)
                }

                const settled = await Promise.race(arrivals)

                if (settled.kind === 'message') {
                  if (settled.result.done) {
                    inputDone = true

                    continue
                  }

                  incoming = messages.next()
                  messageArrival = messageArrives()
                  const message = settled.result.value

                  // Compact turns cannot accept steering; an interrupted turn answers nothing more.
                  if (interrupted || manualCompact) {
                    carried.push(message)
                    emit({
                      event: {
                        type: 'input',
                        receipt: {
                          inputId: message.id,
                          phase: 'carried',
                        },
                      },
                    })
                    yield 'carried'

                    continue
                  }

                  try {
                    await rpc.request({
                      method: 'turn/steer',
                      params: {
                        threadId: id,
                        expectedTurnId: runningTurn,
                        input: turnInput({
                          text: message.text,
                          message,
                        }),
                      },
                    })
                    latestSteering = message
                    inputIds.push(message.id)
                    emit({
                      event: {
                        type: 'input',
                        receipt: {
                          inputId: message.id,
                          phase: 'confirmed',
                          turn: resultId,
                        },
                      },
                    })
                  } catch (error) {
                    // Codex refused the message mid-turn, so it starts the next turn instead.
                    log({
                      level: 'warn',
                      operation: 'codex.steer',
                      correlationId: message.id,
                      error,
                    })
                    carried.push(message)
                    emit({
                      event: {
                        type: 'input',
                        receipt: {
                          inputId: message.id,
                          phase: 'carried',
                        },
                      },
                    })
                    yield 'carried'
                  }

                  continue
                }

                if (settled.result.done) {
                  break
                }

                pendingEvent = events.next()
                eventArrival = eventArrives()
                const event = settled.result.value

                if (!('turn' in event)) {
                  yield event

                  continue
                }

                terminal = event.turn

                // A turn the owner stopped is a finished turn, not a failure.
                if (!manualCompact && event.turn.status !== 'completed' && !(interrupted && event.turn.status === 'interrupted')) {
                  const error = String(object({ value: event.turn.error }).message ?? `Codex turn ${event.turn.status}`)
                  emit({
                    event: {
                      type: 'result',
                      turn: resultId,
                      inputIds,
                      status: 'failed',
                      queued: carried.length,
                      error,
                    },
                  })
                  throw new Error(error)
                }
              }

              let status: 'completed' | 'interrupted' | 'failed' = 'completed'
              let error: string | undefined

              if (terminal?.status === 'interrupted') {
                status = 'interrupted'
              } else if (terminal?.status !== 'completed') {
                status = 'failed'
                error = String(object({ value: terminal?.error }).message ?? 'Codex ended without a successful result')
              }

              const stoppedProcesses = await stoppedCommands
              emit({
                event: {
                  type: 'result',
                  turn: resultId,
                  inputIds,
                  status,
                  error,
                  stoppedProcesses,
                  queued: carried.length,
                },
              })
              turnId = undefined
              interrupted = false
              yield 'finished'
            }
          },
          async set({
            setting,
            value,
          }) {
            options[setting] = value
          },
          async interrupt({ cancelQueued }) {
            interrupted = true

            if (cancelQueued) {
              continuation = undefined

              for (const message of carried.splice(0)) {
                publish?.({
                  event: {
                    type: 'input',
                    receipt: {
                      inputId: message.id,
                      phase: 'refused',
                      stopped: true,
                    },
                  },
                })
              }
            } else if (!carried.length && latestSteering) {
              // The steered message is already in the thread, so the new turn only points at it.
              continuation = {
                id: randomUUID(),
                text: '<pnyx-wake>The owner interrupted your previous step. Answer their latest message above now.</pnyx-wake>',
                images: [],
              }
            }

            if (turnId) {
              try {
                await stopTurn()
              } catch (error) {
                interrupted = false
                throw error
              }

              return
            }

            if (!deferredInterrupt) {
              let resolve = () => {}, reject: ({ error }: { error: unknown }) => void = () => {}
              const done = new Promise<void>((
                yes,
                no,
              ) => {
                resolve = yes
                reject = ({ error }) => no(error)
              })
              deferredInterrupt = {
                done,
                resolve,
                reject,
              }
            }

            await Promise.race([
              deferredInterrupt.done,
              rpc.ended.then(error => {
                throw error
              }),
            ])
          },
          close,
        }

        return nativeSession({ native })
      } catch (error) {
        close()
        throw error
      }
    },
  }
}

export function readCodexUsage({
  reader,
  value,
}: {
  reader: TranscriptUsageReader
  value: unknown
}): void {
  const record = object({ value })
  const payload = object({ value: record.payload })
  const at = typeof record.timestamp === 'string' ? record.timestamp : undefined
  const { rows } = reader

  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    reader.tasks = taskContext({ text: textContent({ value: payload.content }) })
  }

  if (record.type !== 'event_msg' || payload.type !== 'token_count') {
    return
  }

  const info = object({ value: payload.info })
  const last = object({ value: info.last_token_usage })

  if (typeof last.total_tokens === 'number') {
    reader.current.used = last.total_tokens
  }

  if (typeof info.model_context_window === 'number') {
    reader.current.window = info.model_context_window
  }

  const usage = object({ value: info.total_token_usage })
  const total = count({ value: usage.total_tokens })

  if (!total) {
    return
  }

  const delta = total >= reader.previousTotal ? total - reader.previousTotal : total
  reader.previousTotal = total

  if (delta) {
    rows.push({
      at,
      tokens: delta,
      tasks: [...reader.tasks],
    })
  }
}

// Codex's service tier: fast is requested as priority; any other tier is not fast.
function codexFast({ tier }: { tier: unknown }): string | undefined {
  const value = transcriptString({ value: tier })

  return fastSetting({ fast: value === undefined ? undefined : value === 'fast' || value === 'priority' })
}

function approval({ value }: { value: unknown }): string | undefined {
  return transcriptString({
    value,
  }) ?? (Object.keys(object({
    value,
  })).length ? Object.keys(object({
      value,
    }))[0] : undefined)
}

function codexSettings({ record }: {
  record: Record<string, unknown>
}): FoundSettings | undefined {
  const payload = object({ value: record.payload })

  if (record.type === 'session_meta') {
    return foundSettings({
      settings: {
        client: transcriptString({
          value: payload.originator,
        }),
        version: transcriptString({
          value: payload.cli_version,
        }),
      },
    })
  }

  if (record.type === 'turn_context') {
    return foundSettings({
      settings: {
        model: transcriptString({ value: payload.model }),
        effort: transcriptString({ value: payload.effort }),
        fast: codexFast({ tier: payload.service_tier }),
        approval: approval({ value: payload.approval_policy }),
        sandbox: transcriptString({ value: object({ value: payload.sandbox_policy }).type }),
        collaboration: transcriptString({
          value: object({ value: payload.collaboration_mode }).mode,
        }),
        summary: transcriptString({ value: payload.summary }),
      },
    })
  }

  const applied = record.type === 'event_msg' && payload.type === 'thread_settings_applied'

  if (applied) {
    const settings = object({ value: payload.thread_settings })

    return foundSettings({
      settings: {
        model: transcriptString({ value: settings.model }),
        effort: transcriptString({ value: settings.reasoning_effort }),
        fast: codexFast({ tier: settings.service_tier }),
        approval: approval({ value: settings.approval_policy }),
        collaboration: transcriptString({
          value: object({ value: settings.collaboration_mode }).mode,
        }),
        summary: transcriptString({ value: settings.reasoning_summary }),
      },
    })
  }

  return undefined
}

// Later session_index.jsonl records replace the thread name.
export function codexThreadTitle({
  index,
  sessionId,
}: {
  index: string
  sessionId: string
}): SourceNote[] {
  let title: string | undefined
  let at: string | undefined

  for (const line of index.split('\n')) {
    try {
      const r = JSON.parse(line) as {
        id?: unknown
        thread_name?: unknown
        updated_at?: unknown
      }

      if (r.id === sessionId && trimmedString({ value: r.thread_name })) {
        title = trimmedString({ value: r.thread_name })
        at = trimmedString({ value: r.updated_at })
      }
    } catch {
      // A torn or foreign line names no thread.
    }
  }

  return title
    ? [
      {
        kind: 'context',
        source: 'codex',
        text: `${SESSION_TITLE}${title}`,
        ref: `title:${at ?? ''}:${title}`,
        ...(at ? { at } : {}),
      },
    ]
    : []
}

// Codex's code mode runs every tool from one script passed to this tool.
const CODE_MODE_TOOL = 'exec'
// A script calls tools.exec_command({cmd:"git status"}) and friends; a patch names its files on "*** Update File:" lines.
const SCRIPT_CALL = /tools\.(\w+)\(/g
const SCRIPT_COMMAND = /["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*")/
const SCRIPT_PATH = /["']?path["']?\s*:\s*("(?:[^"\\]|\\.)*")/
const PATCHED_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m

const scriptString = ({
  pattern,
  text,
}: {
  pattern: RegExp
  text: string
}): string | undefined => {
  const literal = pattern.exec(text)?.[1]

  if (literal === undefined) {
    return undefined
  }

  try {
    return String(JSON.parse(literal))
  } catch {
    return undefined
  }
}

// The tool calls a code-mode script makes, each with the input its tool reads.
function scriptTools({ script }: { script: string }) {
  const starts = [...script.matchAll(SCRIPT_CALL)]

  return starts.map((
    match,
    index,
  ) => {
    const body = script.slice(
      match.index + match[0].length,
      starts[index + 1]?.index ?? script.length,
    )
    const path = scriptString({
      pattern: SCRIPT_PATH,
      text: body,
    }) ?? PATCHED_FILE.exec(body)?.[1]
    const cmd = scriptString({
      pattern: SCRIPT_COMMAND,
      text: body,
    })

    return {
      tool: match[1]!,
      input: {
        cmd,
        path,
      },
    }
  })
}

function scriptCalls({
  id,
  script,
}: {
  id: string
  script: string
}): TranscriptCall[] {
  return scriptTools({ script }).map(({
    tool,
    input,
  }) => transcriptCall({
    id,
    tool,
    input,
  }))
}

// A script that makes one call reads as that call, so its progress row names what it ran.
function scriptedTrace({ payload }: { payload: Record<string, unknown> }) {
  const codeMode = payload.type === 'custom_tool_call' && payload.name === CODE_MODE_TOOL
  const script = codeMode && typeof payload.input === 'string' ? payload.input : undefined
  const [
    only,
    ...more
  ] = script === undefined ? [] : scriptTools({ script })

  if (only && more.length === 0) {
    return {
      name: only.tool,
      detail: only.input,
    }
  }

  return {
    name: payload.name,
    detail: payload.summary ?? payload.content ?? payload.output
      ?? payload.arguments ?? payload.input,
  }
}

function customCalls({
  id,
  tool,
  input,
}: {
  id: string
  tool: unknown
  input: string
}): TranscriptCall[] {
  if (tool === CODE_MODE_TOOL) {
    return scriptCalls({
      id,
      script: input,
    })
  }

  return [
    transcriptCall({
      id,
      tool,
      input: { path: PATCHED_FILE.exec(input)?.[1] },
    }),
  ]
}

const parsedArguments = ({ text }: { text: unknown }): Record<string, unknown> => {
  try {
    return object({ value: typeof text === 'string' ? JSON.parse(text) : text })
  } catch {
    return {}
  }
}

export const readCodexTranscript: TranscriptReader = ({ record }) => {
  if (typeof record !== 'object' || record === null || !('payload' in record)) {
    return undefined
  }

  const entry = object({ value: record })
  const payload = object({ value: entry.payload })
  const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
  const parsed: TranscriptRecord = {
    role: typeof payload.role === 'string' ? payload.role : String(entry.type),
    at,
    messages: [],
    traces: [],
    calls: [],
    results: [],
    notes: [],
    settings: codexSettings({ record: entry }),
  }

  // Codex's local compaction keeps its summary here; a remote one is encrypted and leaves it empty.
  if (entry.type === 'compacted') {
    parsed.contextReset = true
    const text = trimmedString({ value: payload.message })
    const stamp = trimmedString({ value: entry.timestamp })

    if (text) {
      parsed.notes.push({
        kind: 'summary',
        source: 'codex',
        text,
        ref: `compacted:${stamp ?? ''}:${text}`,
        ...(stamp ? { at: stamp } : {}),
      })
    }
  }

  if (entry.type !== 'response_item') {
    return parsed
  }

  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    if (payload.role === 'assistant') {
      if (payload.phase === 'final_answer') {
        parsed.final = true
      } else if (payload.phase === 'commentary') {
        parsed.final = false
      }
    }

    const content = payload.content

    if (payload.role === 'user') {
      parsed.digest = injectedDigest({ text: textContent({ value: content }) })
    }

    const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content : []
    parsed.messages = transcriptText({
      at,
      texts: blocks.map((
        raw,
        index,
      ) => {
        const text = blockText({ value: raw })
        const before = object({ value: blocks[index - 1] })
        const after = object({ value: blocks[index + 1] })
        // The text blocks Codex wraps around each attached image are not anyone's words.
        const opensImage = after.type === 'input_image' && /^<image\b[^>]*>$/.test(text.trim())
        const closesImage = before.type === 'input_image' && text.trim() === '</image>'

        return {
          text,
          hidden: opensImage || closesImage,
          block: index,
        }
      }),
    })
  }

  const tool = [
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
  ].includes(String(payload.type))
  const thinking = payload.type === 'reasoning'

  if (tool || thinking) {
    parsed.traces.push(transcriptTrace({
      index: 0,
      kind: tool ? 'tool' : 'thinking',
      ...scriptedTrace({ payload }),
      call: payload.call_id ?? payload.id,
    }))
  }

  if (payload.type === 'function_call' && typeof payload.call_id === 'string') {
    parsed.calls.push(transcriptCall({
      id: payload.call_id,
      tool: payload.name,
      input: parsedArguments({ text: payload.arguments }),
    }))
  }

  if (payload.type === 'custom_tool_call' && typeof payload.call_id === 'string' && typeof payload.input === 'string') {
    parsed.calls.push(...customCalls({
      id: payload.call_id,
      tool: payload.name,
      input: payload.input,
    }))
  }

  if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && typeof payload.call_id === 'string') {
    parsed.results.push(payload.call_id)
  }

  return parsed
}
