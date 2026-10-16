import { accountEnvironment, chooseCandidate, dispatchTask, validateChoice, type DispatchChoice } from '../dispatch/select.ts'
import { effectiveDispatch } from '../dispatch/config.ts'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { claudeProvider, transcriptPath, type QueryFn } from './claude.ts'
import { codexProvider, type SpawnCodex } from './codex.ts'
import type { HostedSession, PermissionDecision } from './provider.ts'
import { terminalPresence, type Presence } from '../integrations/presence/check.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { explained, postLine } from '../cli/commands.ts'
import { permissionEvent } from '../core/permissions.ts'
import { HYDRA_CARD, hydraConfig, hydraEvent } from '../core/hydra.ts'
import { freeTask, HOME_SKILL, HYDRA_SKILL } from '../cli/start.ts'
import { decideOutcome, decidePush, decideSession, findCard, type Decision } from '../core/decide.ts'
import { HydraError, type AgentRef, type AgentSession, type AgentSettings, type Attention, type HydraState, type Card, type PermissionRequest } from '../core/model.ts'
import { harnessControls } from '../core/control.ts'
import { INTERRUPTED, liveTask, sessionId } from '../core/tasks.ts'
import { hydraDir, loadHydra, pnyxHome, withWriter, type Writer } from '../store/hydra-store.ts'

export type { QueryFn } from './claude.ts'

export interface Host {
  hydraId: string
  hydra({ text, actor, id }: {
    text: string
    actor: string
    id: string
  }): Promise<Record<string, unknown>>
  start({ task, prompt, folder, settings, id, actor, reason, replacement, dispatch }: {
    task: string
    prompt: string
    folder?: string
    dispatch?: DispatchChoice
    replacement?: string
    settings: AgentSettings
    id: string
    actor: string
    reason?: string
  }): Promise<Record<string, unknown>>
  continue({ task, id, actor, reason, check }: {
    task: string
    id: string
    actor: string
    reason?: string
    check?: boolean
  }): Record<string, unknown>
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

export function createHost({
  hydraId, query, spawnCodex, changed,
  presence = ({ session }) => terminalPresence({ session, verifyProcess: true }),
}: {
  hydraId: string
  query?: QueryFn
  spawnCodex?: SpawnCodex
  presence?({ session }: { session: AgentSession }): Presence
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
  let hydraTurn = Promise.resolve()
  const queuedHydra = new Set<string>()

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
      throw new HydraError({ message: `the agent's folder ${cwd ?? '(none)'} is gone, so its session cannot continue`, code: 'FOLDER_MISSING', help: [card.agent.host === 'pnyx' ? `Run \`pnyx-axi task detach ${card.id}\`, then \`pnyx-axi task start ${card.id} --folder <absolute path>\` to start fresh from the brief` : `Run \`pnyx-axi task start ${card.id} --via pnyx --replace-session ${sessionId({ agent: card.agent })} --folder <absolute path>\` to start fresh from the brief`] })
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

  const outsideSession = ({ writer, card }: { writer: Writer; card: Card }): AgentSession => {
    const agent = card.agent

    if (!liveTask({ card }) || !agent || !['claude-code', 'codex'].includes(agent.provider)
      || agent.host || agent.agentId || agent.paseoAgentId) {
      throw new HydraError({ message: 'Continue in Pnyx needs an outside Claude Code or Codex session attached to a task', code: 'NO_ROUTE' })
    }

    const session = writer.state.sessions?.[sessionId({ agent })]

    if (!session || session.taskId !== card.id) {
      throw new HydraError({ message: 'the session is no longer attached to this task', code: 'SESSION_CONFLICT' })
    }

    return session
  }

  const requireGone = ({ current }: { current: Presence }) => {
    if (current.state !== 'gone') {
      throw new HydraError({ message: current.state === 'present' ? 'the outside session still runs in its terminal; end it before continuing in Pnyx' : `cannot confirm the outside session has ended: ${current.detail}`, code: 'SESSION_RUNNING', help: ['End the outside session, then try Continue in Pnyx again'] })
    }
  }

  const startTarget = ({ writer, ref, replacement }: {
    writer: Writer
    ref: string
    replacement?: string
  }): Card => {
    if (!replacement) {
      return freeTask({ state: writer.state, ref })
    }

    const card = findCard({ state: writer.state, ref })
    const previous = outsideSession({ writer, card })

    if (previous.id !== replacement) {
      throw new HydraError({ message: 'the task has a different session now; reopen its card before starting fresh', code: 'SESSION_CONFLICT' })
    }

    requireGone({ current: presence({ session: previous }) })

    return card
  }

  // Interrupted turns wait for a new message from the owner or Hydra.
  const interrupt = ({ writer, agent, note }: {
    writer: Writer
    agent: AgentRef
    note: string
  }) => {
    record({ writer, agent, input: { activity: 'interrupted' }, actor: 'pnyx' })
    const session = writer.state.sessions?.[sessionId({ agent })]
    const task = session?.id === writer.state.config?.hydra.session
      ? writer.state.cards[HYDRA_CARD]
      : session?.taskId ? writer.state.cards[session.taskId] : undefined

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

  const hydraInstructions = () =>
    `You are Hydra for Pnyx Hydra "${hydraId}". Read ${join(hydraDir({ hydraId }), 'agent', HOME_SKILL, 'SKILL.md')} and follow it. Use pnyx-axi with --hydra ${hydraId}. Projects attach later; your current folder belongs to Hydra.`

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
            const current = session?.id === writer.state.config?.hydra.session
              ? writer.state.cards[HYDRA_CARD]
              : session?.taskId ? writer.state.cards[session.taskId] : undefined

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
        ...(card.id === HYDRA_CARD ? { instructions: hydraInstructions() } : {}),
        env: card.agent.loginFolder ? accountEnvironment({ account: { provider: card.agent.provider === 'codex' ? 'codex' : 'claude', folder: card.agent.loginFolder }, env: environment() }) : environment(),
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
    hydraId,
    hydra: ({ text, actor, id }) => {
      if (queuedHydra.has(id)) {
        return Promise.resolve({ state: 'queued' })
      }

      const requestedAgent = loadHydra({ hydraId }).state.config?.hydra.agent
      queuedHydra.add(id)
      const turn = hydraTurn.then(async () => {
        if (closing) {
          return { state: 'queued' }
        }

        let state = loadHydra({ hydraId }).state
        const config = hydraConfig({ state, id: hydraId })

        if (config.hydra.kind === 'firstmate') {
          return { state: 'queued' }
        }

        if (`${id}:hosted` in state.eventIds) {
          return { state: 'queued' }
        }

        const previous = state.cards[HYDRA_CARD]

        write({
          fn: ({ writer }) => {
            if (previous?.agent?.host === 'pnyx') {
              record({ writer, agent: previous.agent, input: { activity: 'working' }, actor })
            } else {
              apply({ writer, decision: decidePush({ state: writer.state, key: HYDRA_CARD, input: { activity: 'working' }, meta: { at: at(), actor } }) })
            }
          },
        })
        let prepared: HostedSession | undefined

        try {
          if (previous?.agent && previous.agent.host !== 'pnyx') {
            throw new HydraError({ message: 'This Hydra already has an outside agent. Continue it in its own harness.', code: 'NO_ROUTE' })
          }

          const effective = effectiveDispatch({ hydraId, state })
          const candidate = requestedAgent
            ?? effective.dispatch.rules.hydra?.candidates[0]
            ?? effective.dispatch.default[0]
            ?? { harness: 'claude' as const }
          const main = effective.dispatch.main
            && effective.accounts[effective.dispatch.main]?.provider === candidate.harness
            ? effective.dispatch.main
            : Object.keys(effective.accounts).find(name =>
              effective.accounts[name]?.provider === candidate.harness)
          const account = main ? effective.accounts[main] : undefined
          const dispatch = previous?.agent?.provider !== (candidate.harness === 'codex' ? 'codex' : 'claude-code')
            && account && main ? chooseCandidate({
              config: {
                ...effective,
                dispatch: {
                  ...effective.dispatch,
                  default: [candidate],
                  workers: { [account.provider]: [main] },
                  projects: {},
                },
              },
              task: HYDRA_CARD,
            }) : undefined
          const settings: AgentSettings = Object.fromEntries(Object.entries(candidate).filter(([key, value]) => key !== 'harness' && value !== undefined)
            .map(([key, value]) => [key, String(value)]))
          const provider = candidate.harness === 'codex' ? 'codex' : 'claude-code'
          const cwd = join(hydraDir({ hydraId }), 'agent')
          const skill = join(cwd, HOME_SKILL)
          mkdirSync(skill, { recursive: true })
          writeFileSync(join(skill, 'SKILL.md'), readFileSync(HYDRA_SKILL))
          let card = previous
          const previousAgent = card?.agent
          const running = previousAgent && live.get(sessionId({ agent: previousAgent }))

          while (previousAgent && running?.activity === 'working'
            && live.get(sessionId({ agent: previousAgent })) === running && !closing) {
            await new Promise(resolve => setTimeout(resolve, 20))
          }

          if (closing) {
            throw new Error('Pnyx is stopping')
          }

          state = loadHydra({ hydraId }).state
          card = state.cards[HYDRA_CARD]
          const agent = card?.agent?.provider === provider ? card.agent : undefined
          const changedSettings = JSON.stringify(card?.settings ?? {}) !== JSON.stringify(settings)

          if (running && previousAgent && (!agent || changedSettings)) {
            retire({ key: sessionId({ agent: previousAgent }), entry: running })
          }

          if (!agent || !live.has(sessionId({ agent }))) {
            prepared = await providerOf({ provider }).open({
              cwd,
              agent,
              settings,
              instructions: hydraInstructions(),
              env: agent?.loginFolder ? accountEnvironment({
                account: { provider: candidate.harness, folder: agent.loginFolder },
                env: environment(),
              }) : dispatch ? accountEnvironment({
                account: { provider: dispatch.provider, folder: dispatch.folder },
                env: environment(),
              }) : environment(),
              signal: controller.signal,
            })
          }

          const ref: AgentRef = agent ?? { provider, sessionId: prepared!.id, cwd, host: 'pnyx', resume: true, ...(prepared?.path ? { transcriptPath: prepared.path } : {}), ...(dispatch ? { account: dispatch.account, loginFolder: dispatch.folder } : {}) }
          const claimed = write({
            fn: ({ writer }) => {
              const meta = { at: at(), actor }

              if (previousAgent && !agent) {
                harvestTranscripts({ writer, cardIds: [HYDRA_CARD], at: meta.at })
              }

              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: HYDRA_CARD,
                  input: {
                    attention: writer.state.cards[HYDRA_CARD]?.attention
                      .filter(a => a.key !== INTERRUPTED) ?? [],
                  },
                  meta,
                }),
              })
              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: sessionKey({ agent: ref }),
                  input: {
                    agent: ref,
                    title: 'Hydra',
                    settings: {
                      ...Object.fromEntries(Object.keys(card?.settings ?? {})
                        .map(key => [key, null])),
                      ...settings,
                    },
                    activity: 'working',
                    attention: [],
                    source: { adapter: 'pnyx', objectId: ref.sessionId, observedAt: meta.at },
                  },
                  meta,
                }),
              })
              const current = hydraConfig({ state: writer.state, id: hydraId })
              apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:hosted` }, cardId: HYDRA_CARD, change: { type: 'board.configured', data: { ...current, hydra: { ...current.hydra, session: sessionId({ agent: ref }) } } } }) })

              return writer.state.cards[HYDRA_CARD] as Card & { agent: AgentRef }
            },
          })
          const entry = open({ card: claimed, session: prepared })
          prepared = undefined
          entry.activity = 'working'
          entry.input.push({ text })

          return { state: 'queued' }
        } catch (error) {
          prepared?.close()

          if (closing) {
            return { state: 'failed' }
          }

          const detail = `Hydra could not start: ${(error as Error).message}. Check the harness login and settings, then send a message to retry.`
          write({
            fn: ({ writer }) => {
              if (previous?.agent?.host === 'pnyx') {
                record({ writer, agent: previous.agent, input: { activity: 'interrupted' }, actor: 'pnyx' })
              }

              apply({ writer, decision: decidePush({ state: writer.state, key: HYDRA_CARD, input: { activity: 'interrupted' }, meta: { at: at(), actor: 'pnyx' } }) })
              apply({ writer, decision: hydraEvent({ state: writer.state, meta: { at: at(), actor: 'hydra' }, cardId: HYDRA_CARD, change: { type: 'hydra.message', data: { action: 'send', hydra: config.hydra.id, text: detail } } }) })
            },
          })

          return { state: 'failed', detail }
        }
      })
      hydraTurn = turn.then(() => {}, () => {}).finally(() => queuedHydra.delete(id))

      return Promise.resolve({ state: 'queued' })
    },
    start: async ({ task, prompt, folder, settings, id, actor, reason, replacement, dispatch }) => {
      const { target, duplicate } = write({
        fn: ({ writer }) => {
          const target = findCard({ state: writer.state, ref: task })
          const duplicate = `${id}:attach` in writer.state.eventIds

          if (!duplicate) {
            startTarget({ writer, ref: task, replacement })
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
          cwd,
          settings,
          env: dispatch ? accountEnvironment({
            account: { provider: dispatch.provider, folder: dispatch.folder }, env: environment(),
          }) : environment(),
          signal: controller.signal,
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

            startTarget({ writer, ref: task, replacement })

            if ((folder ?? card.folder) !== cwd) {
              throw new HydraError({ message: 'the task folder changed while its agent was starting; retry the start', code: 'CONFLICT' })
            }

            if (!isFolder({ path: cwd })) {
              throw new HydraError({ message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in', code: 'VALIDATION_ERROR', help: ['Pass --folder <absolute path>'] })
            }

            const meta = { at: at(), actor, ...(reason ? { reason } : {}) }

            if (replacement) {
              apply({ writer, decision: decideSession({ state: writer.state, ref: replacement, task: null, meta: { ...meta, id: `${id}:detach` } }) })
            }

            // A marker left by an earlier agent belongs to it, not to the one starting now.
            const attention = card.attention.filter(a => a.key !== INTERRUPTED)
            const input = {
              ...(cwd !== card.folder ? { folder: cwd } : {}),
              ...(attention.length !== card.attention.length ? { attention } : {}),
            }

            if (Object.keys(input).length) {
              apply({ writer, decision: decidePush({ state: writer.state, key: card.key, input, meta: { ...meta, id: `${id}:folder` } }) })
            }

            const agent: AgentRef = { provider, sessionId: prepared.id, cwd, ...(prepared.path ? { transcriptPath: prepared.path } : {}), host: 'pnyx', ...(dispatch ? { account: dispatch.account, loginFolder: dispatch.folder } : {}) }
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

            if (dispatch) {
              apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:dispatch` }, cardId: card.id, change: { type: 'task.launched', data: { via: 'pnyx', at: meta.at, folder: cwd, harness: dispatch.provider, dispatch: dispatch.reason } } }) })
            }

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

    continue: ({ task, id, actor, reason, check }) => write({
      fn: ({ writer }) => {
        const card = findCard({ state: writer.state, ref: task })

        if (!check && `${id}:continue` in writer.state.eventIds) {
          return { task: card.id, event: 'none: duplicate' }
        }

        const session = outsideSession({ writer, card })
        const agent = session.agent

        const current = presence({ session })

        if (check) {
          return { task: card.id, canContinue: current.state === 'gone', folderMissing: !agent.cwd || !isFolder({ path: agent.cwd }), ...current }
        }

        requireGone({ current })

        const cwd = folderOf({ card: { ...card, agent } })
        const meta = { at: at(), actor, ...(reason ? { reason } : {}) }
        apply({ writer, decision: decidePush({ state: writer.state, key: card.key, input: { agent: { ...agent, host: 'pnyx', resume: true, ...(agent.provider === 'claude-code' && !agent.transcriptPath ? { transcriptPath: transcriptPath({ cwd, session: agent.sessionId }) } : {}) }, terminal: {}, activity: 'finished', source: { adapter: 'pnyx', objectId: agent.sessionId, observedAt: meta.at }, attention: card.attention.filter(a => !a.key.startsWith('hook:')) }, meta: { ...meta, id: `${id}:continue` } }) })

        if (card.outcome?.source === 'hooks') {
          apply({ writer, decision: decideOutcome({ state: writer.state, ref: card.id, outcome: null, source: 'hooks', meta: { ...meta, id: `${id}:outcome` } }) })
        }

        return { task: card.id, agent: { harness: agent.provider === 'codex' ? 'codex' : 'claude', session: agent.sessionId, folder: agent.cwd, host: 'pnyx' }, help: [`Send a message with \`pnyx-axi reply ${card.id} --text <text>\` to resume the session in Pnyx`] }
      },
    }),

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
    case 'hydra':
      return host.hydra({ text: field({ body, name: 'text' })!, id: field({ body, name: 'id' })!, actor })

    case 'start': {
      const given = (body.settings ?? {}) as Record<string, unknown>
      const settings = Object.fromEntries(Object.entries(given)
        .filter((e): e is [string, string] => [...SETTINGS, 'provider'].includes(e[0]) && typeof e[1] === 'string' && e[1] !== ''))
      const folder = field({ body, name: 'folder', optional: true })

      if (folder !== undefined && !isAbsolute(folder)) {
        throw new HydraError({ message: 'folder must be an absolute path', code: 'VALIDATION_ERROR' })
      }

      const task = field({ body, name: 'task' })!
      const current = loadHydra({ hydraId: host.hydraId }).state
      const project = findCard({ state: current, ref: task }).project
      const dispatch = body.dispatch
        ? validateChoice({
          value: body.dispatch,
          config: effectiveDispatch({ hydraId: host.hydraId, state: current }),
          project,
        })
        : dispatchTask({
          hydraId: host.hydraId,
          state: current,
          task,
          project,
          rule: field({ body, name: 'rule', optional: true }),
        })

      for (const key of Object.keys(settings)) {
        delete settings[key]
      }

      for (const key of SETTINGS) {
        const value = dispatch.candidate[key as 'model' | 'effort' | 'mode']

        if (value) {
          settings[key] = value
        }
      }

      settings.provider = dispatch.provider === 'codex' ? 'codex' : 'claude-code'

      return host.start({ dispatch, task: field({ body, name: 'task' })!, prompt: field({ body, name: 'prompt' })!, folder, settings, replacement: field({ body, name: 'replacement', optional: true }), id: field({ body, name: 'id' })!, actor, reason: field({ body, name: 'reason', optional: true }) })
    }

    case 'permission': {
      const choice = field({ body, name: 'choice' })

      if (choice !== 'allow' && choice !== 'deny') {
        throw new HydraError({ message: 'choice must be allow or deny', code: 'VALIDATION_ERROR' })
      }

      return host.permission({ task: field({ body, name: 'task' })!, request: field({ body, name: 'request' })!, choice, actor, reason: field({ body, name: 'reason', optional: true }), details: field({ body, name: 'details', optional: true }) })
    }
    case 'continue':
      return host.continue({ task: field({ body, name: 'task' })!, id: field({ body, name: 'id' })!, actor, reason: field({ body, name: 'reason', optional: true }), check: body.check === true })

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
      throw new HydraError({ message: 'action must be start, continue, send, set or permission', code: 'VALIDATION_ERROR' })
  }
}
