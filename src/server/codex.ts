import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Question } from '../core/model.ts'
import { form } from '../integrations/hooks/observe.ts'
import { pnyxHome } from '../store/paths.ts'
import { attachedImages } from '../attachments/images.ts'
import type { AskPermission, HostedText, HostedUsage, ModelOption, PermissionDecision, Provider } from './provider.ts'

export type SpawnCodex = ({
  cwd,
  env,
}: {
  cwd: string
  env: NodeJS.ProcessEnv
}) => ChildProcessWithoutNullStreams

type ObjectValue = Record<string, unknown>
const object = ({ value }: { value: unknown }): ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {}

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
const ASKS = Object.keys(TOOLS)
// Protocol ids a person never needs to judge a request.
const HIDDEN = [
  'threadId',
  'turnId',
  'itemId',
  'approvalId',
  'startedAtMs',
]

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

function connection({ child }: { child: ChildProcessWithoutNullStreams }) {
  let permission: AskPermission | undefined, activeThread: string | undefined
  const approvals = new Map<string | number, {
    abort: AbortController
    thread: unknown
    turn: unknown
  }>()
  const items = new Map<string, ObjectValue>()
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
            const shown = Object.fromEntries(Object.entries(params)
              .filter(([key]) => !HIDDEN.includes(key)))
            const input = {
              ...shown,
              ...(method === 'item/permissions/requestApproval' ? { scope: 'turn' } : {}),
              ...(item?.changes ? { changes: item.changes } : {}),
            }
            const answer = permission && params.threadId === activeThread ? permission({
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
          } else if (message.method === 'thread/tokenUsage/updated' || message.method === 'account/rateLimits/updated') {
            events.push({
              ...object({ value: message.params }),
              method: message.method,
            })
            wake?.()
          } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/completed') {
            const params = object({ value: message.params })
            const item = object({ value: params.item })

            if (message.method === 'item/agentMessage/delta' || item.type === 'agentMessage') {
              events.push({
                ...params,
                method: message.method,
              })
              wake?.()
            } else if (item.type === 'contextCompaction') {
              compacted = true
            }
          } else if (message.method === 'item/started') {
            const item = object({ value: object({ value: message.params }).item })

            if (item.type === 'fileChange' && typeof item.id === 'string') {
              items.set(
                item.id,
                item,
              )
            }
          }
        } else if (typeof message.id === 'number') {
          const request = pending.get(message.id)
          pending.delete(message.id)

          if (message.error) {
            const error = object({ value: message.error })
            request?.reject({ error: new Error(String(error.message ?? 'Codex request failed')) })
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
    }: {
      ask: AskPermission
      thread: string
    }) {
      permission = ask
      activeThread = thread
    },
    async request({
      method,
      params,
    }: {
      method: string
      params: ObjectValue
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
            30000,
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
    }: {
      threadId: string
      turnId: string
    }): AsyncGenerator<HostedText | HostedUsage | { turn: ObjectValue }> {
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

          if (turn.id === turnId) {
            yield { turn }

            return
          }

          if (event.turnId === turnId) {
            const item = object({ value: event.item })
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

// A shell_environment_policy that inherits only core variables would drop Pnyx's own, so they are set explicitly.
const pnyxShellEnvironment = ({ env }: { env: NodeJS.ProcessEnv }) => Object.fromEntries(Object
  .entries(env)
  .filter(([
    name,
    value,
  ]) => name.startsWith('PNYX_') && value !== undefined)
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
    },
  ),
}: { spawnCodex?: SpawnCodex }): Provider {
  return {
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
              models.push({
                value: model.model,
                label: model.displayName,
                ...(model.isDefault === true ? { isDefault: true } : {}),
                ...(typeof model.defaultReasoningEffort === 'string' ? { defaultEffort: model.defaultReasoningEffort } : {}),
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
      context,
    }) {
      const rpc = connection({
        child: spawnCodex({
          cwd,
          env,
        }),
      })

      const close = () => {
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
        const result = await rpc.request({
          method: agent ? 'thread/resume' : 'thread/start',
          params: {
            ...(agent ? { threadId: agent.sessionId } : {}),
            cwd,
            // Lets a worker ask the owner with request_user_input outside plan mode.
            config: {
              ...pnyxShellEnvironment({ env }),
              'features.default_mode_request_user_input': true,
            },
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
        const stopTurn = () => rpc.request({
          method: 'turn/interrupt',
          params: {
            threadId: id,
            turnId,
          },
        })

        return {
          id,
          ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
          async* run({
            input,
            permission,
          }) {
            rpc.permissions({
              ask: permission,
              thread: id,
            })
            const messages = input[Symbol.asyncIterator]()
            const ended = rpc.ended.then(error => {
              throw error
            })
            // ponytail: Codex has no session hooks here, so the context leads the first turn and the turn after a compaction; a compaction mid-turn waits for the next turn.
            let fresh = true
            // One read of the next message is always open, so a message that arrives mid-turn joins the running turn.
            let incoming = messages.next()
            let inputDone = false
            // Messages Codex refused to steer in because their turn had just ended; each opens a turn of its own.
            const carried: string[] = []
            // text may lead with the context; the images come only from what was said.
            const turnInput = ({
              text,
              said,
            }: {
              text: string
              said: string
            }) => [
              {
                type: 'text',
                text,
                text_elements: [],
              },
              // Only the message's own images, never one named in the context before it.
              ...attachedImages({
                text: said,
                hydras: join(
                  pnyxHome(),
                  'hydras',
                ),
              }).filter(path => existsSync(path))
                .map(path => ({
                  type: 'localImage',
                  path,
                })),
            ]

            for (;;) {
              let said = carried.shift()

              if (said === undefined && inputDone) {
                return
              }

              if (said === undefined) {
                const next = await Promise.race([
                  incoming,
                  ended,
                ])

                if (next.done) {
                  return
                }

                said = next.value
                incoming = messages.next()
              }

              const text = context && (rpc.compacted() || fresh) ? `${context()}\n\n${said}` : said
              fresh = false
              yield 'working'
              const result = await rpc.request({
                method: 'turn/start',
                params: {
                  threadId: id,
                  input: turnInput({
                    text,
                    said,
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
              const turn = object({ value: result.turn })

              if (typeof turn.id !== 'string') {
                throw new Error('Codex returned no turn id')
              }

              turnId = turn.id
              const runningTurn = turn.id

              // A stop that came before Codex named the turn applies now.
              if (interrupted) {
                await stopTurn()
              }

              const events = rpc.completed({
                threadId: id,
                turnId: runningTurn,
              })[Symbol.asyncIterator]()
              let pendingEvent = events.next()
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

              for (;;) {
                const arrivals = [eventArrives()]

                if (!inputDone) {
                  arrivals.push(messageArrives())
                }

                const settled = await Promise.race(arrivals)

                if (settled.kind === 'message') {
                  if (settled.result.done) {
                    inputDone = true

                    continue
                  }

                  incoming = messages.next()
                  const message = settled.result.value
                  let steered = true

                  try {
                    await rpc.request({
                      method: 'turn/steer',
                      params: {
                        threadId: id,
                        expectedTurnId: runningTurn,
                        input: turnInput({
                          text: message,
                          said: message,
                        }),
                      },
                    })
                  } catch {
                    steered = false
                  }

                  if (!steered) {
                    carried.push(message)
                  }

                  continue
                }

                if (settled.result.done) {
                  break
                }

                pendingEvent = events.next()
                const event = settled.result.value

                if (!('turn' in event)) {
                  yield event

                  continue
                }

                // A turn the owner stopped is a finished turn, not a failure.
                if (event.turn.status !== 'completed' && !(interrupted && event.turn.status === 'interrupted')) {
                  throw new Error(String(object({ value: event.turn.error }).message ?? `Codex turn ${event.turn.status}`))
                }
              }

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
          async interrupt() {
            interrupted = true

            if (turnId) {
              await stopTurn()
            }
          },
          close,
        }
      } catch (error) {
        close()
        throw error
      }
    },
  }
}
