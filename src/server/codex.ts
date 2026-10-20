import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Question } from '../core/model.ts'
import { form } from '../integrations/hooks/observe.ts'
import { pnyxHome } from '../store/paths.ts'
import type { AskPermission, HostedText, ModelOption, PermissionDecision, Provider } from './provider.ts'

export type SpawnCodex = ({ cwd, env }: {
  cwd: string
  env: NodeJS.ProcessEnv
}) => ChildProcessWithoutNullStreams

type ObjectValue = Record<string, unknown>
const object = ({ value }: { value: unknown }): ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {}

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
const HIDDEN = ['threadId', 'turnId', 'itemId', 'approvalId', 'startedAtMs']

// request_user_input questions; one without options takes typed text only.
function userQuestions({ value }: { value: unknown }): (Question & { id: string })[] {
  return (Array.isArray(value) ? value : []).flatMap(raw => {
    const q = object({ value: raw })
    const options = (Array.isArray(q.options) ? q.options : []).map(o => object({ value: o })).filter(o => typeof o.label === 'string')

    return typeof q.id === 'string' && typeof q.question === 'string'
      ? [{
        id: q.id,
        question: q.question,
        ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
        ...(q.isSecret === true ? { secret: true } : {}),
        options: options.map(o => ({ label: o.label as string, ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}) })),
      }]
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
  let next = 0, stopped = false, failure: Error | undefined, stderr = ''
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

  child.stderr.on('data', data => {
    stderr = (stderr + String(data)).slice(-2000)
  })
  child.stdin.on('error', error => stop({ error }))
  child.on('error', error => stop({ error }))
  child.on('exit', (code, signal) => stop({ error: new Error(`Codex app-server exited (${signal ?? code})${stderr ? `: ${stderr}` : ''}`) }))
  lines.on('line', line => {
    try {
      const message = object({ value: JSON.parse(line) })

      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          const id = message.id

          if ((typeof id !== 'string' && typeof id !== 'number') || approvals.has(id)) {
            return
          }

          if (!ASKS.includes(message.method)) {
            write({ message: { id, error: { code: -32601, message: 'Pnyx cannot answer this request yet' } } })

            return
          }

          const params = object({ value: message.params })
          const abort = new AbortController()
          approvals.set(id, { abort, thread: params.threadId, turn: params.turnId })
          const item = typeof params.itemId === 'string' ? items.get(params.itemId) : undefined
          const method = message.method
          const asked = method === 'item/tool/requestUserInput'
            ? userQuestions({ value: params.questions })
            : []
          const elicitation = method === 'mcpServer/elicitation/request'
          const fields = elicitation
            ? form({ payload: { requested_schema: params.requestedSchema, mode: params.mode } })
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
          }) : Promise.resolve({ behavior: 'deny' as const, message: '' })

          const respond = ({ decision }: { decision: PermissionDecision }) => {
            if (!failure && approvals.get(id)?.abort === abort) {
              approvals.delete(id)
              const allow = decision.behavior === 'allow'
              const requested = object({ value: params.permissions })
              const permissions = Object.fromEntries(
                Object.entries(requested).filter(([, value]) => value !== null),
              )
              const result = method === 'item/permissions/requestApproval'
                ? { permissions: allow ? permissions : {}, scope: 'turn' }
                : method === 'item/tool/requestUserInput'
                  ? {
                    answers: allow
                      ? Object.fromEntries(asked.map((q, i) => [
                        q.id, { answers: decision.answers?.[i] ?? [] },
                      ]))
                      : {},
                  }
                  : elicitation
                    ? allow ? { action: 'accept', content: decision.values ?? {} } : { action: 'decline' }
                    : { decision: allow ? 'accept' : 'decline' }
              write({ message: { id, result } })
            }
          }

          void answer.then(decision => respond({ decision }), () => respond({ decision: { behavior: 'deny', message: '' } }))
        } else if (message.method === 'serverRequest/resolved' || message.method === 'turn/completed') {
          const params = object({ value: message.params })
          const turn = object({ value: params.turn })

          for (const [id, request] of approvals) {
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
        } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/completed') {
          const params = object({ value: message.params })
          const item = object({ value: params.item })

          if (message.method === 'item/agentMessage/delta' || item.type === 'agentMessage') {
            events.push({ ...params, method: message.method })
            wake?.()
          }
        } else if (message.method === 'item/started') {
          const item = object({ value: object({ value: message.params }).item })

          if (item.type === 'fileChange' && typeof item.id === 'string') {
            items.set(item.id, item)
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
  })
  lines.on('close', () => stop({ error: new Error('Codex app-server closed its output') }))

  return {
    ended,
    permissions({ ask, thread }: { ask: AskPermission; thread: string }) {
      permission = ask
      activeThread = thread
    },
    async request({ method, params }: {
      method: string
      params: ObjectValue
    }): Promise<ObjectValue> {
      const id = ++next
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        return await new Promise<ObjectValue>((resolve, reject) => {
          timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`Codex ${method} timed out`))
          }, 30000).unref()
          pending.set(id, {
            resolve: ({ value }) => resolve(value),
            reject: ({ error }) => reject(error),
          })

          try {
            write({ message: { id, method, params } })
          } catch (error) {
            pending.delete(id)
            reject(error)
          }
        })
      } finally {
        clearTimeout(timer)
      }
    },
    notify({ method }: { method: string }) {
      write({ message: { method } })
    },
    async* completed({ threadId, turnId }: {
      threadId: string
      turnId: string
    }): AsyncGenerator<HostedText | { turn: ObjectValue }> {
      for (;;) {
        if (failure) {
          throw failure
        }

        const event = events.shift()

        if (event) {
          const turn = object({ value: event.turn })

          if (event.threadId !== threadId) {
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
              yield { type: 'text', id, text, append: event.method === 'item/agentMessage/delta' }
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
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      child.once('exit', () => clearTimeout(kill))
    },
  }
}

// A mode is an approval policy with the sandbox it implies: an agent that never asks gets full access, and
// one that asks writes only in its folder and Pnyx's home until an approval lets a command out. Network
// stays open so pnyx-axi reaches the local server.
const sandboxPolicy = ({ mode, env }: { mode: string; env: NodeJS.ProcessEnv }) => mode === 'never'
  ? { type: 'dangerFullAccess' }
  : { type: 'workspaceWrite', writableRoots: [env.PNYX_HOME || pnyxHome()], networkAccess: true }

// A shell_environment_policy that inherits only core variables would drop Pnyx's own, so they are set explicitly.
const pnyxShellEnvironment = ({ env }: { env: NodeJS.ProcessEnv }) => Object.fromEntries(Object
  .entries(env)
  .filter(([name, value]) => name.startsWith('PNYX_') && value !== undefined)
  .map(([name, value]) => [`shell_environment_policy.set.${name}`, value]))

export function codexProvider({ spawnCodex = ({ cwd, env }) => spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: 'pipe' }) }: { spawnCodex?: SpawnCodex }): Provider {
  return {
    async models({ cwd, env }) {
      const rpc = connection({ child: spawnCodex({ cwd, env }) })

      try {
        await rpc.request({ method: 'initialize', params: { clientInfo: { name: 'pnyx', version: '0.0.0' }, capabilities: null } })
        rpc.notify({ method: 'initialized' })
        const models: ModelOption[] = []
        let cursor: string | undefined

        do {
          const page = await rpc.request({ method: 'model/list', params: { ...(cursor ? { cursor } : {}) } })

          for (const raw of Array.isArray(page.data) ? page.data : []) {
            const model = object({ value: raw })

            if (typeof model.model === 'string' && typeof model.displayName === 'string') {
              models.push({
                value: model.model,
                label: model.displayName,
                ...(model.isDefault === true ? { isDefault: true } : {}),
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
    // ponytail: Codex has no per-command allow list here, so `allow` is unused and a Codex Hydra asks in its chat.
    async open({ cwd, agent, settings, env, signal, instructions }) {
      const rpc = connection({ child: spawnCodex({ cwd, env }) })

      const close = () => {
        signal.removeEventListener('abort', close)
        rpc.close()
      }

      signal.addEventListener('abort', close, { once: true })

      if (signal.aborted) {
        close()
      }

      try {
        await rpc.request({ method: 'initialize', params: { clientInfo: { name: 'pnyx', version: '0.0.0' }, capabilities: null } })
        rpc.notify({ method: 'initialized' })
        const options = { ...settings }
        const result = await rpc.request({
          method: agent ? 'thread/resume' : 'thread/start',
          params: {
            ...(agent ? { threadId: agent.sessionId } : {}),
            cwd,
            // Lets a worker ask the owner with request_user_input outside plan mode.
            config: { ...pnyxShellEnvironment({ env }), 'features.default_mode_request_user_input': true },
            ...(instructions ? { developerInstructions: instructions } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.fast !== undefined ? { serviceTier: options.fast === 'true' ? 'fast' : 'default' } : {}),
            ...(options.mode ? { approvalPolicy: options.mode, sandbox: options.mode === 'never' ? 'danger-full-access' : 'workspace-write' } : {}),
          },
        })
        const thread = object({ value: result.thread })

        if (typeof thread.id !== 'string' || !thread.id || (agent && thread.id !== agent.sessionId)) {
          throw new Error('Codex returned an unexpected thread id')
        }

        const id = thread.id

        return {
          id,
          ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
          async* run({ input, permission }) {
            rpc.permissions({ ask: permission, thread: id })
            const messages = input[Symbol.asyncIterator]()

            for (;;) {
              const next = await Promise.race([
                messages.next(), rpc.ended.then(error => {
                  throw error
                }),
              ])

              if (next.done) {
                return
              }

              const text = next.value
              yield 'working'
              const result = await rpc.request({
                method: 'turn/start',
                params: {
                  threadId: id,
                  input: [{ type: 'text', text, text_elements: [] }],
                  ...(options.model ? { model: options.model } : {}),
                  ...(options.fast !== undefined ? { serviceTier: options.fast === 'true' ? 'fast' : 'default' } : {}),
                  ...(options.effort ? { effort: options.effort } : {}),
                  ...(options.mode
                    ? {
                      approvalPolicy: options.mode,
                      sandboxPolicy: sandboxPolicy({ mode: options.mode, env }),
                    }
                    : {}),
                },
              })
              const turn = object({ value: result.turn })

              if (typeof turn.id !== 'string') {
                throw new Error('Codex returned no turn id')
              }

              for await (const event of rpc.completed({ threadId: id, turnId: turn.id })) {
                if (!('turn' in event)) {
                  yield event

                  continue
                }

                if (event.turn.status !== 'completed') {
                  throw new Error(String(object({ value: event.turn.error }).message ?? `Codex turn ${event.turn.status}`))
                }
              }

              yield 'finished'
            }
          },
          async set({ setting, value }) {
            options[setting] = value
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
