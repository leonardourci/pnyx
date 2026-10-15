import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { claudeProvider, type QueryFn } from './claude.ts'
import { codexProvider, type SpawnCodex } from './codex.ts'
import type { HostedSession, PermissionDecision } from './provider.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { explained, postLine } from '../cli/commands.ts'
import { permissionEvent } from '../core/permissions.ts'
import { freeTask } from '../cli/start.ts'
import { decidePush, decideSession, findCard, type Decision } from '../core/decide.ts'
import { HydraError, type AgentRef, type AgentSettings, type Attention, type HydraState, type Card, type PermissionRequest } from '../core/model.ts'
import { harnessControls } from '../core/control.ts'
import { INTERRUPTED, sessionId } from '../core/tasks.ts'
import { pnyxHome, withWriter, type Writer } from '../store/hydra-store.ts'

export type { QueryFn } from './claude.ts'

export interface Host {
  start({ task, prompt, folder, settings, id, actor, reason }: {
    task: string
    prompt: string
    folder?: string
    settings: AgentSettings
    id: string
    actor: string
    reason?: string
  }): Promise<Record<string, unknown>>
  send({ card, text, actor }: { card: string; text: string; actor: string }): void
  set({ card, setting, value, actor }: {
    card: string
    setting: string
    value: string
    actor: string
  }): Promise<void>
  permission({ task, request, choice, actor, reason, details }: {
    task: string
    request: string
    choice: 'allow' | 'deny'
    actor: string
    reason?: string
    details?: string
  }): Record<string, unknown>
  reconcile({ state }: { state: HydraState }): void
  // Marks a hosted turn that was running when the server last stopped as interrupted.
  recover(): void
  close(): void
}

export const SETTINGS = ['model', 'effort', 'mode']
// An idle session's process is closed after this long; its next message resumes it.
const IDLE_MS = 10 * 60 * 1000
// The agent must not inherit the server's terminal, task or actor.
const INHERITED = /^(PNYX_|TMUX|HERDR_|PASEO_|TERM_PROGRAM|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_THREAD_ID$|CODEX_PARENT_THREAD_ID$)/

function isFolder({ path }: { path: string }): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function inbox() {
  const items: string[] = []
  let wake: (() => void) | undefined, done = false

  return {
    push({ text }: { text: string }) {
      items.push(text)
      wake?.()
    },
    pending() {
      return items.length
    },
    end() {
      done = true
      wake?.()
    },
    async* [Symbol.asyncIterator](): AsyncGenerator<string> {
      for (;;) {
        if (items.length) {
          yield items.shift()!
        } else if (done) {
          return
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
          wake = undefined
        }
      }
    },
  }
}

interface Live {
  input: ReturnType<typeof inbox>
  // The provider may still be loading when the first message arrives.
  session?: HostedSession
  activity: string
  // A setting this process could not take: it is replaced once its turn is over.
  stale?: boolean
  idle?: ReturnType<typeof setTimeout>
}

export function createHost({ hydraId, query, spawnCodex, changed }: {
  hydraId: string
  query?: QueryFn
  spawnCodex?: SpawnCodex
  changed(): void
}): Host {
  const providers = { 'claude-code': claudeProvider({ query }), codex: codexProvider({ spawnCodex }) }
  const controller = new AbortController()
  const starting = new Set<string>()
  const live = new Map<string, Live>()
  const pending = new Map<string, {
    card: string
    entry: Live
    finish({ result }: { result: PermissionDecision }): void
  }>()
  let closing = false

  const write = <T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T => {
    const result = withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })

        return fn({ writer })
      },
    })
    changed()

    return result
  }

  const apply = ({ writer, decision }: { writer: Writer; decision: Decision }) => {
    if ('event' in decision) {
      writer.append({ event: decision.event })
    }
  }

  const sessionKey = ({ agent }: { agent: AgentRef }) => `${agent.provider === 'claude-code' ? 'claude' : agent.provider}:${agent.sessionId}`

  const expire = ({ id }: { id: string }) => {
    const waiting = pending.get(id)

    if (!waiting) {
      return
    }

    waiting.finish({ result: { behavior: 'deny', message: 'This permission request expired.' } })
    note({
      fn: ({ writer }) => {
        const card = writer.state.cards[waiting.card]
        const request = card?.permissions?.find(p => p.id === id && p.status === 'pending')

        if (card && request) {
          writer.append({ event: permissionEvent({ state: writer.state, card, request: { ...request, status: 'expired' }, meta: { at: at(), actor: 'pnyx' } }) })
        }
      },
    })
  }

  const expireEntry = ({ entry }: { entry: Live }) => {
    for (const [id, waiting] of pending) {
      if (waiting.entry === entry) {
        expire({ id })
      }
    }
  }

  const retire = ({ key, entry }: { key: string; entry: Live }) => {
    clearTimeout(entry.idle)
    expireEntry({ entry })

    if (live.get(key) === entry) {
      live.delete(key)
    }

    entry.input.end()
    entry.session?.close()
  }

  const folderOf = ({ card }: { card: Card & { agent: AgentRef } }): string => {
    const { cwd } = card.agent

    if (!cwd || !isFolder({ path: cwd })) {
      throw new HydraError({ message: `the agent's folder ${cwd ?? '(none)'} is gone, so its session cannot continue`, code: 'FOLDER_MISSING', help: [`Run \`pnyx-axi task detach ${card.id}\`, then \`pnyx-axi task start ${card.id}\` to start fresh from the brief`] })
    }

    return cwd
  }

  const at = () => new Date().toISOString()

  const record = ({ writer, agent, input, actor }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
  }) => {
    // Sessions may move between tasks while their process keeps running.
    const session = writer.state.sessions?.[sessionId({ agent })]
    const card = session && writer.state.cards[session.taskId ?? session.originCardId]

    apply({
      writer,
      decision: decidePush({
        state: writer.state,
        key: card?.key ?? sessionKey({ agent }),
        input: { agent: session?.agent ?? agent, ...input, source: { adapter: 'pnyx', objectId: agent.sessionId, observedAt: at() } },
        meta: { at: at(), actor },
      }),
    })
  }

  const hosted = ({ writer, ref }: { writer: Writer; ref: string }): Card & { agent: AgentRef } => {
    const card = findCard({ state: writer.state, ref })

    if (card.agent?.host !== 'pnyx') {
      throw new HydraError({ message: `card ${card.id} has no agent that Pnyx runs`, code: 'NO_ROUTE' })
    }

    return card as Card & { agent: AgentRef }
  }

  // Interrupted turns wait for a new message from the owner or Hydra.
  const interrupt = ({ writer, agent, note }: {
    writer: Writer
    agent: AgentRef
    note: string
  }) => {
    record({ writer, agent, input: { activity: 'interrupted' }, actor: 'pnyx' })
    const session = writer.state.sessions?.[sessionId({ agent })]
    const task = session?.taskId ? writer.state.cards[session.taskId] : undefined

    if (task) {
      const attention: Attention[] = [{ kind: 'interrupted', key: INTERRUPTED, blocking: true, text: note }, ...task.attention.filter(a => a.key !== INTERRUPTED)]
      apply({ writer, decision: decidePush({ state: writer.state, key: task.key, input: { attention }, meta: { at: at(), actor: 'pnyx' } }) })
    }
  }

  // A failed write is logged, not thrown: the agent keeps running and the next change records again.
  const note = ({ fn }: { fn: ({ writer }: { writer: Writer }) => void }) => {
    try {
      write({ fn })
    } catch (error) {
      console.error(`pnyx-axi serve: ${(error as Error).message}`)
    }
  }

  const environment = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name))),
    PNYX_HOME: pnyxHome(),
    PNYX_HYDRA: hydraId,
  })

  const providerOf = ({ provider }: { provider: string }) => {
    if (provider !== 'claude-code' && provider !== 'codex') {
      throw new HydraError({ message: `unsupported hosted provider: ${provider}`, code: 'VALIDATION_ERROR' })
    }

    return providers[provider]
  }

  const askPermission = ({ key, entry, tool, input, signal, description }: {
    tool: string
    input: Record<string, unknown>
    signal: AbortSignal
    description?: string
    key: string
    entry: Live
  }): Promise<PermissionDecision> => {
    if (closing || signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: 'This permission request expired.' })
    }

    return new Promise<PermissionDecision>(resolve => {
      const id = randomUUID()
      const abort = () => expire({ id })

      const finish = ({ result }: { result: PermissionDecision }) => {
        pending.delete(id)
        signal.removeEventListener('abort', abort)
        resolve(result)
      }

      const request: PermissionRequest = {
        id,
        session: key,
        tool,
        input,
        status: 'pending',
        ...(description ? { description } : {}),
      }
      signal.addEventListener('abort', abort, { once: true })

      try {
        write({
          fn: ({ writer }) => {
            const session = writer.state.sessions?.[key]
            const current = session?.taskId ? writer.state.cards[session.taskId] : undefined

            if (!current || current.agent?.host !== 'pnyx' || sessionId({ agent: current.agent }) !== key) {
              throw new HydraError({ message: 'the agent is no longer attached to this task', code: 'NO_ROUTE' })
            }

            pending.set(id, { card: current.id, entry, finish })
            writer.append({ event: permissionEvent({ state: writer.state, card: current, request, meta: { at: at(), actor: 'pnyx' } }) })
          },
        })
      } catch (error) {
        finish({ result: { behavior: 'deny', message: `Could not record permission: ${(error as Error).message}` } })
      }
    })
  }

  const consume = async ({ key, card, entry }: {
    key: string
    card: Card & { agent: AgentRef }
    entry: Live
  }) => {
    let failure: string | undefined

    try {
      entry.session ??= await providerOf({ provider: card.agent.provider }).open({
        cwd: folderOf({ card }),
        agent: card.agent,
        settings: card.settings ?? {},
        env: environment(),
        signal: controller.signal,
      })

      if (closing || live.get(key) !== entry) {
        entry.session.close()

        return
      }

      for await (const activity of entry.session.run({
        input: entry.input,
        permission: ({ tool, input, signal, description }) => askPermission({
          key, entry, tool, input, signal, description,
        }),
      })) {
        if (activity === 'finished' && entry.input.pending()) {
          continue
        }

        if (activity !== entry.activity) {
          entry.activity = activity
          note({ fn: ({ writer }) => record({ writer, agent: card.agent, input: { activity }, actor: 'pnyx' }) })
          clearTimeout(entry.idle)

          if (activity === 'finished') {
            if (entry.stale) {
              retire({ key, entry })
            } else {
              entry.idle = setTimeout(() => retire({ key, entry }), IDLE_MS).unref()
            }
          }
        }
      }
    } catch (error) {
      failure = (error as Error).message
    }

    retire({ key, entry })

    if (!closing && entry.activity === 'working') {
      const name = card.agent.provider === 'codex' ? 'Codex' : 'Claude Code'
      const text = `${name} stopped during this turn${failure ? `: ${failure.slice(0, 300)}` : ''}. Send a message to continue it.`
      note({ fn: ({ writer }) => interrupt({ writer, agent: card.agent, note: text }) })
    }
  }

  const open = ({ card, session }: {
    card: Card & { agent: AgentRef }
    session?: HostedSession
  }): Live => {
    const key = sessionId({ agent: card.agent })
    const running = live.get(key)

    if (running?.stale && running.activity !== 'working') {
      retire({ key, entry: running })
    } else if (running) {
      clearTimeout(running.idle)

      return running
    }

    folderOf({ card })
    const entry: Live = { input: inbox(), activity: 'finished', session }
    live.set(key, entry)
    void consume({ key, card, entry })

    return entry
  }

  const send = ({ card: ref, text, actor }: { card: string; text: string; actor: string }) => {
    const card = write({
      fn: ({ writer }) => {
        const card = hosted({ writer, ref })

        if (!live.has(sessionId({ agent: card.agent }))) {
          folderOf({ card })
        }

        if (card.attention.some(a => a.key === INTERRUPTED)) {
          const attention = card.attention.filter(a => a.key !== INTERRUPTED)
          const meta = { at: at(), actor }
          const input = { attention }
          const decision = decidePush({ state: writer.state, key: card.key, input, meta })
          apply({ writer, decision })
        }

        record({ writer, agent: card.agent, input: { activity: 'working' }, actor })

        return writer.state.cards[card.id] as Card & { agent: AgentRef }
      },
    })
    const entry = open({ card })
    entry.activity = 'working'
    entry.input.push({ text })
  }

  return {
    start: async ({ task, prompt, folder, settings, id, actor, reason }) => {
      const { target, duplicate } = write({
        fn: ({ writer }) => {
          const target = findCard({ state: writer.state, ref: task })
          const duplicate = `${id}:attach` in writer.state.eventIds

          if (!duplicate) {
            freeTask({ state: writer.state, ref: task })
          }

          return { target, duplicate }
        },
      })

      if (duplicate) {
        return { task: target.id, event: 'none: duplicate', help: ['This start was already recorded; nothing was started again'] }
      }

      if (starting.has(target.id)) {
        throw new HydraError({ message: `task ${target.id} is already starting`, code: 'SESSION_CONFLICT' })
      }

      const cwd = folder ?? target.folder

      if (!cwd || !isFolder({ path: cwd })) {
        throw new HydraError({ message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in', code: 'VALIDATION_ERROR', help: ['Pass --folder <absolute path>'] })
      }

      const provider = settings.provider ?? 'claude-code'
      const { provider: _provider, ...options } = settings
      void _provider
      settings = options
      starting.add(target.id)
      let session: HostedSession | undefined

      try {
        const prepared = await providerOf({ provider }).open({
          cwd, settings, env: environment(), signal: controller.signal,
        })
        session = prepared

        if (closing) {
          throw new Error('Pnyx is stopping')
        }

        const claimed = write({
          fn: ({ writer }) => {
            const card = findCard({ state: writer.state, ref: task })

            if (`${id}:attach` in writer.state.eventIds) {
              return { card, duplicate: true as const }
            }

            freeTask({ state: writer.state, ref: task })

            if ((folder ?? card.folder) !== cwd) {
              throw new HydraError({ message: 'the task folder changed while its agent was starting; retry the start', code: 'CONFLICT' })
            }

            if (!isFolder({ path: cwd })) {
              throw new HydraError({ message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in', code: 'VALIDATION_ERROR', help: ['Pass --folder <absolute path>'] })
            }

            const meta = { at: at(), actor, ...(reason ? { reason } : {}) }
            // A marker left by an earlier agent belongs to it, not to the one starting now.
            const attention = card.attention.filter(a => a.key !== INTERRUPTED)
            const input = {
              ...(cwd !== card.folder ? { folder: cwd } : {}),
              ...(attention.length !== card.attention.length ? { attention } : {}),
            }

            if (Object.keys(input).length) {
              apply({ writer, decision: decidePush({ state: writer.state, key: card.key, input, meta: { ...meta, id: `${id}:folder` } }) })
            }

            const agent: AgentRef = { provider, sessionId: prepared.id, cwd, ...(prepared.path ? { transcriptPath: prepared.path } : {}), host: 'pnyx' }
            apply({
              writer,
              decision: decidePush({
                state: writer.state,
                key: sessionKey({ agent }),
                input: { title: card.title, agent, ...(Object.keys(settings).length ? { settings } : {}), activity: 'working', source: { adapter: 'pnyx', objectId: agent.sessionId, observedAt: meta.at } },
                meta: { ...meta, id: `${id}:session` },
              }),
            })
            apply({ writer, decision: decideSession({ state: writer.state, ref: sessionId({ agent }), task: card.id, meta: { ...meta, id: `${id}:attach` } }) })

            const started = writer.state.cards[card.id] as Card & { agent: AgentRef }

            return { card: started, duplicate: false as const }
          },
        })

        if (claimed.duplicate) {
          session.close()

          return { task: claimed.card.id, event: 'none: duplicate', help: ['This start was already recorded; nothing was started again'] }
        }

        const entry = open({ card: claimed.card, session })
        entry.activity = 'working'
        entry.input.push({ text: prompt })

        return {
          task: claimed.card.id,
          agent: { harness: provider === 'codex' ? 'codex' : 'claude', session: claimed.card.agent.sessionId, folder: claimed.card.agent.cwd, host: 'pnyx' },
          help: [`Run \`pnyx-axi reply ${claimed.card.id} --text <text>\` to continue; the Pnyx server runs the agent`],
        }
      } catch (error) {
        session?.close()
        throw error
      } finally {
        starting.delete(target.id)
      }
    },

    send,

    permission: ({ task, request: id, choice, actor, reason, details }) => {
      const why = explained({ meta: { at: at(), actor, reason } })
      const waiting = pending.get(id)
      const result = write({
        fn: ({ writer }) => {
          const card = findCard({ state: writer.state, ref: task })
          const request = card.permissions?.find(p => p.id === id)

          if (!request) {
            throw new HydraError({ message: `permission request not found: ${id}`, code: 'NOT_FOUND' })
          }

          if (request.status !== 'pending') {
            throw new HydraError({ message: `permission request is already ${request.status}`, code: 'PERMISSION_CLOSED' })
          }

          if (!waiting || waiting.card !== card.id || card.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
            writer.append({ event: permissionEvent({ state: writer.state, card, request: { ...request, status: 'expired' }, meta: { at: at(), actor: 'pnyx' } }) })

            return { expired: true as const }
          }

          writer.append({
            event: permissionEvent({
              state: writer.state,
              card,
              request: { ...request, status: choice },
              meta: { at: at(), actor, reason: why },
            }),
          })
          let posted: string | undefined

          if (actor === 'hydra') {
            try {
              posted = postLine({ writer, hydraId, meta: { at: at(), actor, details }, cardId: card.id, action: `${choice === 'allow' ? 'Allowed' : 'Denied'} ${request.tool} on ${card.title}`, reason: why })
            } catch (error) {
              posted = `none: ${(error as Error).message}`
            }
          }

          return {
            expired: false as const,
            receipt: { task: card.id, request: id, status: choice, ...(posted ? { posted } : {}) },
          }
        },
      })

      if (result.expired) {
        waiting?.finish({ result: { behavior: 'deny', message: 'This permission request expired.' } })
        throw new HydraError({ message: 'the agent no longer waits for this request', code: 'PERMISSION_CLOSED' })
      }

      waiting?.finish({ result: choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: why || 'Permission denied from Pnyx.' } })

      return result.receipt
    },

    set: async ({ card: ref, setting, value, actor }) => {
      const card = write({
        fn: ({ writer }) => {
          const card = hosted({ writer, ref })
          const controls = harnessControls({ provider: card.agent.provider, hosted: true })
          const control = controls?.controls.find(c => c.setting === setting)

          if (!control || !control.options.some(o => o.value === value)) {
            throw new HydraError({ message: `${setting} cannot be ${value}`, code: 'VALIDATION_ERROR' })
          }

          record({ writer, agent: card.agent, input: { settings: { [setting]: value } }, actor })

          return card
        },
      })
      const key = sessionId({ agent: card.agent })
      const running = live.get(key)

      if (!running) {
        return
      }

      try {
        if (!running.session) {
          throw new Error('Provider is still loading')
        }

        await running.session.set({ setting, value })
      } catch {
        // Some settings require replacing the process after its current turn.
        running.stale = true

        if (running.activity !== 'working') {
          retire({ key, entry: running })
        }
      }
    },

    reconcile: ({ state }) => {
      for (const [id, waiting] of pending) {
        const card = state.cards[waiting.card]
        const request = card?.permissions?.find(p => p.id === id)

        if (!request || request.status !== 'pending' || card?.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
          expire({ id })
        }
      }
    },

    recover: () => write({
      fn: ({ writer }) => {
        for (const card of Object.values(writer.state.cards)) {
          for (const request of card.permissions ?? []) {
            if (request.status === 'pending' && !pending.has(request.id)) {
              writer.append({ event: permissionEvent({ state: writer.state, card, request: { ...request, status: 'expired' }, meta: { at: at(), actor: 'pnyx' } }) })
            }
          }
        }

        for (const session of Object.values(writer.state.sessions ?? {})) {
          if (session.agent.host === 'pnyx' && !live.has(session.id) && (session.sessionActivity ?? session.activity) === 'working') {
            interrupt({ writer, agent: session.agent, note: 'Pnyx stopped during this turn. Send a message to continue it.' })
          }
        }
      },
    }),

    close: () => {
      closing = true
      controller.abort()

      for (const [key, entry] of live) {
        retire({ key, entry })
      }
    },
  }
}

const field = ({ body, name, optional = false }: {
  body: Record<string, unknown>
  name: string
  optional?: boolean
}): string | undefined => {
  const value = body[name]

  if (value === undefined && optional) {
    return undefined
  }

  if (typeof value !== 'string' || !value.trim() || value.length > 32000) {
    throw new HydraError({ message: `${name} must be a string of 1 to 32000 characters`, code: 'VALIDATION_ERROR' })
  }

  return value
}

export async function hostRequest({ host, body: raw }: {
  host: Host
  body: unknown
}): Promise<Record<string, unknown>> {
  const body = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const actor = field({ body, name: 'actor', optional: true }) ?? 'cli'

  switch (body.action) {
    case 'start': {
      const given = (body.settings ?? {}) as Record<string, unknown>
      const settings = Object.fromEntries(Object.entries(given)
        .filter((e): e is [string, string] => [...SETTINGS, 'provider'].includes(e[0]) && typeof e[1] === 'string' && e[1] !== ''))
      const folder = field({ body, name: 'folder', optional: true })

      if (folder !== undefined && !isAbsolute(folder)) {
        throw new HydraError({ message: 'folder must be an absolute path', code: 'VALIDATION_ERROR' })
      }

      return host.start({ task: field({ body, name: 'task' })!, prompt: field({ body, name: 'prompt' })!, folder, settings, id: field({ body, name: 'id' })!, actor, reason: field({ body, name: 'reason', optional: true }) })
    }

    case 'permission': {
      const choice = field({ body, name: 'choice' })

      if (choice !== 'allow' && choice !== 'deny') {
        throw new HydraError({ message: 'choice must be allow or deny', code: 'VALIDATION_ERROR' })
      }

      return host.permission({ task: field({ body, name: 'task' })!, request: field({ body, name: 'request' })!, choice, actor, reason: field({ body, name: 'reason', optional: true }), details: field({ body, name: 'details', optional: true }) })
    }

    case 'send':
      host.send({ card: field({ body, name: 'card' })!, text: field({ body, name: 'text' })!, actor })

      return { sent: true }
    case 'set': {
      const setting = field({ body, name: 'setting' })!
      const value = field({ body, name: 'value' })!

      if (!SETTINGS.includes(setting)) {
        throw new HydraError({ message: `${setting} cannot be ${value}`, code: 'VALIDATION_ERROR', help: [`Settings: ${SETTINGS.join(', ')}`] })
      }

      await host.set({ card: field({ body, name: 'card' })!, setting, value, actor })

      return { set: true }
    }

    default:
      throw new HydraError({ message: 'action must be start, send, set or permission', code: 'VALIDATION_ERROR' })
  }
}
