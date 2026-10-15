import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { EffortLevel, Options, PermissionMode, Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { freeTask } from '../cli/start.ts'
import { decidePush, decideSession, findCard, type Decision } from '../core/decide.ts'
import { HydraError, type AgentRef, type AgentSettings, type Attention, type Card } from '../core/model.ts'
import { INTERRUPTED, sessionId } from '../core/tasks.ts'
import { pnyxHome, withWriter, type Writer } from '../store/hydra-store.ts'

export type QueryFn = typeof query
type UserMessage = Parameters<QueryFn>[0]['prompt'] extends string | AsyncIterable<infer M> ? M : never

export interface Host {
  start({ task, prompt, folder, settings, id, actor, reason }: {
    task: string
    prompt: string
    folder?: string
    settings: AgentSettings
    id: string
    actor: string
    reason?: string
  }): Record<string, unknown>
  send({ card, text, actor }: { card: string; text: string; actor: string }): void
  set({ card, setting, value, actor }: {
    card: string
    setting: string
    value: string
    actor: string
  }): Promise<void>
  // Marks a hosted turn that was running when the server last stopped as interrupted.
  recover(): void
  close(): void
}

const PROVIDER = 'claude-code'
export const SETTINGS = ['model', 'effort', 'mode']
// An idle session's process is closed after this long; its next message resumes it.
const IDLE_MS = 10 * 60 * 1000
// The server's own launch context, which would make the agent report the server's
// terminal, task or actor as its own.
const INHERITED = /^(PNYX_|TMUX|HERDR_|PASEO_|TERM_PROGRAM|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$)/
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'] satisfies EffortLevel[]
const MODES: readonly string[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] satisfies PermissionMode[]

// Where Claude Code keeps a session's transcript. Hooks report the exact path later.
// ponytail: folder names past 200 characters get a hash suffix we do not reproduce; the first hook corrects it.
const transcriptPath = ({ cwd, session }: { cwd: string; session: string }) =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)

function isFolder({ path }: { path: string }): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// The task's recorded settings as Claude Code options; settings it does not take are left out.
function sdkOptions({ settings }: { settings: AgentSettings }): Partial<Options> {
  const { model, effort, mode } = settings

  return {
    ...(model ? { model } : {}),
    ...(effort && EFFORTS.includes(effort) ? { effort: effort as EffortLevel } : {}),
    ...(mode && MODES.includes(mode) ? { permissionMode: mode as PermissionMode } : {}),
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
  }
}

// Messages the agent reads as they come, so one sent mid-turn queues in Claude Code itself.
function inbox() {
  const items: UserMessage[] = []
  let wake: (() => void) | undefined, done = false

  return {
    push({ text }: { text: string }) {
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
      wake?.()
    },
    end() {
      done = true
      wake?.()
    },
    async* [Symbol.asyncIterator](): AsyncGenerator<UserMessage> {
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

function turnOf({ message }: { message: SDKMessage }): 'working' | 'finished' | undefined {
  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return message.state === 'idle' ? 'finished' : 'working'
  }

  return message.type === 'result' ? 'finished' : undefined
}

interface Live {
  input: ReturnType<typeof inbox>
  // Set once the SDK has loaded and Claude Code is starting.
  query?: Query
  activity: string
  // A setting this process could not take: it is replaced once its turn is over.
  stale?: boolean
  idle?: ReturnType<typeof setTimeout>
}

// Runs Claude Code for the tasks Pnyx starts, through the Agent SDK. Each task records its
// session, folder and settings as events; a session's process starts when a message needs
// it and resumes the same session from Claude Code's own history.
export function createHost({ hydraId, query, changed }: {
  hydraId: string
  query?: QueryFn
  changed(): void
}): Host {
  const live = new Map<string, Live>()
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

  const sessionKey = ({ agent }: { agent: AgentRef }) => `claude:${agent.sessionId}`

  const retire = ({ key, entry }: { key: string; entry: Live }) => {
    clearTimeout(entry.idle)

    if (live.get(key) === entry) {
      live.delete(key)
    }

    entry.input.end()
    entry.query?.close()
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
    // As hooks do, a push goes to the card that holds the session now, its task once
    // attached, so the session keeps the task's view of its settings and terminal.
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

  // The task waits on its owner or Hydra: Claude Code keeps no turn half done, so the
  // next message continues the conversation.
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

  const consume = async ({ key, agent, entry, options }: {
    key: string
    agent: AgentRef
    entry: Live
    options: Options
  }) => {
    let failure: string | undefined

    try {
      // Loaded on first use, so commands that never host an agent do not load the SDK.
      const run = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query

      if (closing) {
        return
      }

      entry.query = run({ prompt: entry.input, options })

      for await (const message of entry.query) {
        const activity = turnOf({ message })

        if (activity && activity !== entry.activity) {
          entry.activity = activity
          note({ fn: ({ writer }) => record({ writer, agent, input: { activity }, actor: 'pnyx' }) })
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

    clearTimeout(entry.idle)

    if (live.get(key) === entry) {
      live.delete(key)
    }

    if (!closing && entry.activity === 'working') {
      const text = `Claude Code stopped during this turn${failure ? `: ${failure.slice(0, 300)}` : ''}. Send a message to continue it.`
      note({ fn: ({ writer }) => interrupt({ writer, agent, note: text }) })
    }
  }

  const open = ({ card }: { card: Card & { agent: AgentRef } }): Live => {
    const key = sessionId({ agent: card.agent })
    const running = live.get(key)

    if (running?.stale && running.activity !== 'working') {
      retire({ key, entry: running })
    } else if (running) {
      clearTimeout(running.idle)

      return running
    }

    const cwd = folderOf({ card })
    const { sessionId: id, transcriptPath: path } = card.agent
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !INHERITED.test(name)))

    const entry: Live = { input: inbox(), activity: 'finished' }
    const options: Options = {
      cwd,
      // A session with a transcript resumes it; one that never got that far starts under its recorded id.
      ...(path && existsSync(path) ? { resume: id } : { sessionId: id }),
      // The user's own settings, so their skills, hooks, permissions and CLAUDE.md apply.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      // Pnyx cannot answer permission prompts yet: what would ask is refused and Claude says so.
      permissionPrompts: 'none',
      env: { ...env, PNYX_HOME: pnyxHome(), PNYX_HYDRA: hydraId },
      ...sdkOptions({ settings: card.settings ?? {} }),
    }
    live.set(key, entry)
    void consume({ key, agent: card.agent, entry, options })

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
    start: ({ task, prompt, folder, settings, id, actor, reason }) => {
      const claimed = write({
        fn: ({ writer }) => {
          const card = findCard({ state: writer.state, ref: task })

          if (`${id}:attach` in writer.state.eventIds) {
            return { card, duplicate: true as const }
          }

          freeTask({ state: writer.state, ref: task })
          const cwd = folder ?? card.folder

          if (!cwd || !isFolder({ path: cwd })) {
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

          const session = randomUUID()
          const agent: AgentRef = { provider: PROVIDER, sessionId: session, cwd, transcriptPath: transcriptPath({ cwd, session }), host: 'pnyx' }
          apply({
            writer,
            decision: decidePush({
              state: writer.state,
              key: sessionKey({ agent }),
              input: { title: card.title, agent, ...(Object.keys(settings).length ? { settings } : {}), activity: 'working', source: { adapter: 'pnyx', objectId: session, observedAt: meta.at } },
              meta: { ...meta, id: `${id}:session` },
            }),
          })
          apply({ writer, decision: decideSession({ state: writer.state, ref: sessionId({ agent }), task: card.id, meta: { ...meta, id: `${id}:attach` } }) })

          const started = writer.state.cards[card.id] as Card & { agent: AgentRef }

          return { card: started, duplicate: false as const }
        },
      })

      if (claimed.duplicate) {
        return { task: claimed.card.id, event: 'none: duplicate', help: ['This start was already recorded; nothing was started again'] }
      }

      const entry = open({ card: claimed.card })
      entry.activity = 'working'
      entry.input.push({ text: prompt })

      return {
        task: claimed.card.id,
        agent: { harness: 'claude', session: claimed.card.agent.sessionId, folder: claimed.card.agent.cwd, host: 'pnyx' },
        help: [`Run \`pnyx-axi reply ${claimed.card.id} --text <text>\` to continue; the Pnyx server runs the agent`],
      }
    },

    send,

    set: async ({ card: ref, setting, value, actor }) => {
      const card = write({
        fn: ({ writer }) => {
          const card = hosted({ writer, ref })
          record({ writer, agent: card.agent, input: { settings: { [setting]: value } }, actor })

          return card
        },
      })
      const key = sessionId({ agent: card.agent })
      const running = live.get(key)

      if (!running) {
        return
      }

      // Still loading: its options were built before this change.
      if (!running.query) {
        running.stale = true

        return
      }

      try {
        if (setting === 'model') {
          await running.query.setModel(value)
        } else if (setting === 'mode' && MODES.includes(value)) {
          await running.query.setPermissionMode(value as PermissionMode)
        } else if (setting === 'effort' && EFFORTS.includes(value)) {
          await running.query.applyFlagSettings({ effortLevel: value as EffortLevel })
        }
      } catch {
        // Refused by the running process (bypass needs a session started for it): the
        // recorded setting applies from a new process once this turn is over.
        running.stale = true

        if (running.activity !== 'working') {
          retire({ key, entry: running })
        }
      }
    },

    recover: () => write({
      fn: ({ writer }) => {
        for (const session of Object.values(writer.state.sessions ?? {})) {
          if (session.agent.host === 'pnyx' && !live.has(session.id) && (session.sessionActivity ?? session.activity) === 'working') {
            interrupt({ writer, agent: session.agent, note: 'Pnyx stopped during this turn. Send a message to continue it.' })
          }
        }
      },
    }),

    close: () => {
      closing = true

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
        .filter((e): e is [string, string] => SETTINGS.includes(e[0]) && typeof e[1] === 'string' && e[1] !== ''))
      const folder = field({ body, name: 'folder', optional: true })

      if (folder !== undefined && !isAbsolute(folder)) {
        throw new HydraError({ message: 'folder must be an absolute path', code: 'VALIDATION_ERROR' })
      }

      return host.start({ task: field({ body, name: 'task' })!, prompt: field({ body, name: 'prompt' })!, folder, settings, id: field({ body, name: 'id' })!, actor, reason: field({ body, name: 'reason', optional: true }) })
    }

    case 'send':
      host.send({ card: field({ body, name: 'card' })!, text: field({ body, name: 'text' })!, actor })

      return { sent: true }
    case 'set': {
      const setting = field({ body, name: 'setting' })!
      const value = field({ body, name: 'value' })!
      const allowed = { effort: EFFORTS, mode: MODES }[setting]

      if (!SETTINGS.includes(setting) || (allowed && !allowed.includes(value))) {
        throw new HydraError({ message: `${setting} cannot be ${value}`, code: 'VALIDATION_ERROR', help: [`Settings: ${SETTINGS.join(', ')}; effort ${EFFORTS.join('|')}; mode ${MODES.join('|')}`] })
      }

      await host.set({ card: field({ body, name: 'card' })!, setting, value, actor })

      return { set: true }
    }

    default:
      throw new HydraError({ message: 'action must be start, send or set', code: 'VALIDATION_ERROR' })
  }
}
