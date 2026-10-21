import { accountEnvironment, chooseCandidate, chosenSettings, ruleCandidates, validateChoice, type DispatchChoice } from '../dispatch/select.ts'
import { effectiveDispatch, type Harness } from '../dispatch/config.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { claudeProvider, transcriptPath, type QueryFn } from './claude.ts'
import { codexProvider, type SpawnCodex } from './codex.ts'
import { modelIds, type HostedSession, type ModelOption, type PermissionDecision } from './provider.ts'
import { liveReplies } from './streaming.ts'
import type { ThreadPage } from '../thread/read.ts'
import { seenAt, terminalPresence, type Presence } from '../integrations/presence/check.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { explained, postLine } from '../cli/commands.ts'
import { permissionAnswer, permissionEvent } from '../core/permissions.ts'
import { HYDRA_CARD, QUIET_REPLY, hostedHydra, hydraConfig, hydraEvent, wakesHydra } from '../core/hydra.ts'
import { freeTask } from '../cli/start.ts'
import { hydraDigest } from '../core/digest.ts'
import { prepareHydraFolder } from '../integrations/skills/install.ts'
import { decideOutcome, decidePush, decideSession, findCard, type Decision } from '../core/decide.ts'
import { HydraError, HYDRA_ACTOR, type AgentRef, type AgentSession, type AgentSettings, type Attention, type HydraState, type Card, type PermissionRequest } from '../core/model.ts'
import { findOption, harnessControls } from '../core/control.ts'
import { INTERRUPTED, liveTask, sessionId } from '../core/tasks.ts'
import { hydraDir, loadHydra, pnyxHome, readEvents, withWriter, type Writer } from '../store/hydra-store.ts'

export type { QueryFn } from './claude.ts'

export interface Host {
  hydraId: string
  models({ harness }: { harness: 'claude' | 'codex' }): Promise<ModelOption[]>
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
  permission({ task, request, choice, answer, actor, reason, details }: {
    task: string
    request: string
    choice: 'allow' | 'deny'
    answer?: unknown
    actor: string
    reason?: string
    details?: string
  }): Record<string, unknown>
  reconcile({ state }: { state: HydraState }): void
  // Queues a check turn for a hosted Hydra once a change it tracks lands at seq.
  wake({ seq }: { seq: number }): void
  // Marks a hosted turn that was running when the server last stopped as interrupted.
  recover(): void
  thread({ card, page }: { card: Card; page: ThreadPage }): ThreadPage
  close(): void
}

export const SETTINGS = ['model', 'effort', 'mode']
// An idle session's process is closed after this long; its next message resumes it.
const IDLE_MS = 10 * 60 * 1000
// A wake waits this long so a worker's declaration and finished turn share one check turn.
const WAKE_MS = 5000
// A request left pending or a working worker quiet this long wakes Hydra again.
const STALL_MS = 240_000
const ALLOWED = 'Allowed'
// A worker runs the pnyx-worker skill's own commands without asking; any other pnyx-axi command still asks.
const WORKER_COMMANDS = ['task show', 'task history', 'task status', 'task chat', 'hydra send', 'link'].map(command => `pnyx-axi ${command}`)
// The agent must not inherit the server's terminal, task or actor.
const INHERITED = /^(PNYX_|TMUX|HERDR_|PASEO_|TERM_PROGRAM|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_THREAD_ID$|CODEX_PARENT_THREAD_ID$)/

// A wake's turn id names the last change it covers; its turn is recorded as `<id>:hosted`.
const wakeId = ({ through }: { through: number }) => `wake:${through}`
const WAKE_TURN = /^wake:(\d+):hosted$/

// A wake counts once its turn starts, as its prompt is then in Hydra's session.
function wakeCursor({ state, fallback }: { state: HydraState; fallback: number }): number {
  const covered = Object.keys(state.eventIds).flatMap(id => WAKE_TURN.exec(id)?.[1] ?? [])
    .map(Number)

  return covered.length ? Math.max(...covered) : fallback
}

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
  replies: ReturnType<typeof liveReplies>
  // The provider may still be loading when the first message arrives.
  session?: HostedSession
  activity: string
  // When its latest message went in, so a turn that has not written yet is not read as quiet.
  sentAt?: number
  // A setting this process could not take: it is replaced once its turn is over.
  stale?: boolean
  idle?: ReturnType<typeof setTimeout>
}

export function createHost({
  hydraId, query, spawnCodex, changed, streamed = () => {},
  wakeDelay = WAKE_MS, stallDelay = STALL_MS,
  presence = ({ session }) => terminalPresence({ session, verifyProcess: true }),
}: {
  hydraId: string
  query?: QueryFn
  spawnCodex?: SpawnCodex
  presence?({ session }: { session: AgentSession }): Presence
  changed(): void
  streamed?({ session }: { session: string }): void
  wakeDelay?: number
  stallDelay?: number
}): Host {
  const providers = { 'claude-code': claudeProvider({ query }), codex: codexProvider({ spawnCodex }) }
  const modelCatalogs = new Map<string, Promise<ModelOption[]>>()
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
  // Recorded wakes, or wakeStart before the first, say how far Hydra has checked.
  let wakeThrough = 0, wakeStart: number | undefined
  let wakeTimer: ReturnType<typeof setTimeout> | undefined

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
    streamed({ session: key })
  }

  const folderOf = ({ card }: { card: Card & { agent: AgentRef } }): string => {
    const { cwd } = card.agent

    if (!cwd || !isFolder({ path: cwd })) {
      throw new HydraError({ message: `the agent's folder ${cwd ?? '(none)'} is gone, so its session cannot continue`, code: 'FOLDER_MISSING', help: [card.agent.host === 'pnyx' ? `Run \`pnyx-axi task detach ${card.id}\`, then \`pnyx-axi task start ${card.id} --folder <absolute path>\` to start fresh from the brief` : `Run \`pnyx-axi task start ${card.id} --via pnyx --replace-session ${sessionId({ agent: card.agent })} --folder <absolute path>\` to start fresh from the brief`] })
    }

    return cwd
  }

  const at = () => new Date().toISOString()

  const record = ({ writer, agent, input, actor, id }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
    id?: string
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
        meta: { at: at(), actor, ...(id ? { id } : {}) },
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

  // Interrupted turns wait for a new message from the owner or Hydra; id marks one that is resumed.
  const interrupt = ({ writer, agent, note, id }: {
    writer: Writer
    agent: AgentRef
    note: string
    id?: string
  }) => {
    record({ writer, agent, input: { activity: 'interrupted' }, actor: 'pnyx', id })
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

  // Hydra's own commands are recorded as its writes, so they never wake it; a worker's carry its task.
  const environment = ({ hydra = false, task }: { hydra?: boolean; task?: string } = {}) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name))),
    PNYX_HOME: pnyxHome(),
    PNYX_HYDRA: hydraId,
    ...(hydra ? { PNYX_ACTOR: HYDRA_ACTOR } : task ? { PNYX_ACTOR: `worker:${task}` } : {}),
  })

  const hydraInstructions = () =>
    `You are Hydra for Pnyx Hydra "${hydraId}". Your contract is AGENTS.md in your current folder; follow it. Use pnyx-axi with --hydra ${hydraId}; PNYX_ACTOR=hydra is already set. Projects attach later; your current folder belongs to Hydra.`
  const digest = () => hydraDigest({ hydraId, state: loadHydra({ hydraId }).state })
  // Hydra runs Pnyx's own CLI without asking; every other prompt waits in Hydra's chat.
  const hydraSession = () => ({ instructions: hydraInstructions(), allow: ['pnyx-axi'], context: digest })

  const providerOf = ({ provider }: { provider: string }) => {
    if (provider !== 'claude-code' && provider !== 'codex') {
      throw new HydraError({ message: `unsupported hosted provider: ${provider}`, code: 'VALIDATION_ERROR' })
    }

    return providers[provider]
  }

  const askPermission = ({ key, entry, tool, input, signal, description, questions, form }: {
    tool: string
    input: Record<string, unknown>
    signal: AbortSignal
    description?: string
    key: string
    entry: Live
  } & Pick<PermissionRequest, 'questions' | 'form'>): Promise<PermissionDecision> => {
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
        ...(questions?.length ? { questions } : {}),
        ...(form ? { form } : {}),
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
    const env = environment(card.id === HYDRA_CARD ? { hydra: true } : { task: card.id })

    try {
      entry.session ??= await providerOf({ provider: card.agent.provider }).open({
        cwd: folderOf({ card }),
        agent: card.agent,
        settings: card.settings ?? {},
        ...(card.id === HYDRA_CARD ? hydraSession() : { allow: WORKER_COMMANDS }),
        env: card.agent.loginFolder ? accountEnvironment({ account: { provider: card.agent.provider === 'codex' ? 'codex' : 'claude', folder: card.agent.loginFolder }, env }) : env,
        signal: controller.signal,
      })

      if (closing || live.get(key) !== entry) {
        entry.session.close()

        return
      }

      const offsets: number[] = []
      let completedOffset = 0

      const transcriptSize = () => {
        try {
          return statSync(entry.session?.path ?? card.agent.transcriptPath ?? '').size
        } catch {
          return 0
        }
      }

      const input = async function* () {
        for await (const text of entry.input) {
          offsets.push(transcriptSize())
          yield text
        }
      }

      for await (const activity of entry.session.run({
        input: input(),
        permission: ({ tool, input, signal, description, questions, form }) => askPermission({
          key, entry, tool, input, signal, description, questions, form,
        }),
      })) {
        if (typeof activity !== 'string') {
          entry.replies.update(activity)
          streamed({ session: key })

          continue
        }

        if (activity === 'finished') {
          completedOffset = transcriptSize()
          entry.replies.finish()
          streamed({ session: key })
        } else {
          entry.replies.start({ offset: Math.max(offsets.shift() ?? 0, completedOffset) })
          streamed({ session: key })
        }

        if (activity === 'finished' && entry.input.pending()) {
          continue
        }

        if (activity !== entry.activity) {
          entry.activity = activity
          note({ fn: ({ writer }) => record({ writer, agent: card.agent, input: { activity }, actor: 'pnyx' }) })
          clearTimeout(entry.idle)

          if (activity === 'finished') {
            if (card.id === HYDRA_CARD) {
              armWake()
            }

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
    const entry: Live = { input: inbox(), replies: liveReplies(), activity: 'finished', session }
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
    entry.sentAt = Date.now()
    entry.input.push({ text })
  }

  // One check turn at a time; a busy Hydra is woken when its turn finishes.
  const armWake = () => {
    if (!closing && !wakeTimer && wakeThrough) {
      wakeTimer = setTimeout(fireWake, wakeDelay)
    }
  }

  const fireWake = () => {
    wakeTimer = undefined
    const state = loadHydra({ hydraId }).state
    const session = state.config?.hydra.session
    const card = state.cards[HYDRA_CARD]
    const after = wakeCursor({ state, fallback: wakeStart ?? 0 })

    // An interrupted Hydra waits for the owner; the next change after that wakes it.
    if (closing || !hostedHydra({ state }) || wakeThrough <= after
      || (card?.sessionActivity ?? card?.activity) === 'interrupted'
      || card?.attention.some(a => a.key === INTERRUPTED)
      || queuedHydra.size || (session && live.get(session)?.activity === 'working')) {
      return
    }

    void host.hydra({ id: wakeId({ through: wakeThrough }), actor: 'pnyx', text: `<pnyx-wake>A worker or reminder changed something you track. Run \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\` and handle what it lists. If nothing needs the owner, write no other text and reply only ${QUIET_REPLY}.</pnyx-wake>` })
  }

  // A stall makes no event, so it is polled; each one wakes Hydra once.
  const checkStalls = () => {
    try {
      wakeOnStall()
    } catch (error) {
      console.error(`pnyx-axi serve: ${(error as Error).message}`)
    }
  }

  const wakeOnStall = () => {
    if (!pending.size && ![...live.values()].some(entry => entry.activity === 'working')) {
      return
    }

    const state = loadHydra({ hydraId }).state
    const hydraCard = state.cards[HYDRA_CARD]
    const session = state.config?.hydra.session

    if (closing || !hostedHydra({ state }) || queuedHydra.size
      || (hydraCard?.sessionActivity ?? hydraCard?.activity) === 'interrupted'
      || hydraCard?.attention.some(a => a.key === INTERRUPTED)
      || (session && live.get(session)?.activity === 'working')) {
      return
    }

    const now = Date.now()
    const stalls = Object.values(state.cards).flatMap(card => {
      if (card.id === HYDRA_CARD || !card.agent || card.agent.host !== 'pnyx') {
        return []
      }

      const requests = (card.permissions ?? []).filter(p => p.status === 'pending')
      const agent = state.sessions?.[sessionId({ agent: card.agent })]
      const entry = live.get(sessionId({ agent: card.agent }))
      const seen = Math.max(agent ? seenAt({ session: agent }) : 0, entry?.sentAt ?? 0)

      return requests.length
        ? requests.flatMap(p => {
          const waited = p.at ? now - Date.parse(p.at) : 0

          return waited >= stallDelay ? [{ id: `stall:${p.id}`, text: `${p.tool} on ${card.id} has waited ${Math.round(waited / 1000)} s for an answer` }] : []
        })
        : entry?.activity === 'working' && seen && now - seen >= stallDelay
          ? [{ id: `stall:${card.id}:${seen}`, text: `the worker on ${card.id} has been working with no sign of life for ${Math.round((now - seen) / 1000)} s` }]
          : []
    })
      .filter(stall => !stalled.has(stall.id))

    const [first] = stalls

    if (first) {
      stalls.forEach(stall => stalled.add(stall.id))
      const after = wakeCursor({ state, fallback: wakeStart ?? 0 })
      void host.hydra({ id: first.id, actor: 'pnyx', text: `<pnyx-wake>Stalled: ${stalls.map(s => s.text).join('; ')}. Run \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\`; its requests and agents show what waits. If it waits on the owner, remind them in one line of reply text; otherwise answer it or nudge the worker. Reply only ${QUIET_REPLY} when it has already cleared.</pnyx-wake>` })
    }
  }

  const stalled = new Set<string>()
  const stallTimer = setInterval(checkStalls, Math.min(stallDelay / 4, 15_000))
  stallTimer.unref()

  const host: Host = {
    async models({ harness }) {
      const state = loadHydra({ hydraId }).state
      const effective = effectiveDispatch({ hydraId, state })
      const main = effective.dispatch.main
        && effective.accounts[effective.dispatch.main]?.provider === harness
        ? effective.dispatch.main : Object.keys(effective.accounts).find(name =>
          effective.accounts[name]?.provider === harness)
      const account = main ? effective.accounts[main] : undefined
      const env = account ? accountEnvironment({ account, env: environment() }) : environment()

      const key = `${harness}:${account?.folder ?? ''}`
      let catalog = modelCatalogs.get(key)

      if (!catalog) {
        const provider = providerOf({ provider: providerName({ harness }) })
        const cwd = hydraDir({ hydraId })
        const stored = storedModels({ key })

        // The folder's own settings apply on top of the shared list; a failed read is dropped so the picker can retry.
        const settle = ({ models }: { models: ModelOption[] | Promise<ModelOption[]> }) => {
          const settled = Promise.resolve(models)
            .then(models => provider.defaults({ cwd, env, models }))
          modelCatalogs.set(key, settled)
          void settled.catch(() => {
            if (modelCatalogs.get(key) === settled) {
              modelCatalogs.delete(key)
            }
          })

          return settled
        }

        // The harness is read once per server; a stored list answers meanwhile and a failed read keeps it.
        const read = provider.models({ cwd, env }).then(models => {
          const changed = JSON.stringify(models) !== JSON.stringify(stored)

          if (changed) {
            storeModels({ key, models })
          }

          if (changed && stored) {
            void settle({ models })
          }

          return models
        })
        void read.catch(() => {})
        catalog = settle({ models: stored ?? read })
      }

      return catalog
    },
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
          const provider = providerName({ harness: candidate.harness })
          const dispatch = previous?.agent?.provider !== provider
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
              offers: candidate.model
                ? await catalogOffers({ host, harnesses: [candidate.harness] }) : undefined,
            }) : undefined
          const settings: AgentSettings = Object.fromEntries(Object.entries(candidate).filter(([key, value]) => key !== 'harness' && value !== undefined)
            .map(([key, value]) => [key, String(value)]))
          const cwd = join(hydraDir({ hydraId }), 'agent')
          prepareHydraFolder({ folder: cwd })
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
              ...hydraSession(),
              env: agent?.loginFolder ? accountEnvironment({
                account: { provider: candidate.harness, folder: agent.loginFolder },
                env: environment({ hydra: true }),
              }) : dispatch ? accountEnvironment({
                account: { provider: dispatch.provider, folder: dispatch.folder },
                env: environment({ hydra: true }),
              }) : environment({ hydra: true }),
              signal: controller.signal,
            })
          }

          const ref: AgentRef = agent ?? { provider, sessionId: prepared!.id, cwd, host: 'pnyx', ...(prepared?.path ? { transcriptPath: prepared.path } : {}), ...(dispatch ? { account: dispatch.account, loginFolder: dispatch.folder } : {}) }
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
          // A session that opens puts the digest before its first message; a wake into a running one carries it.
          const opened = Boolean(prepared)
          const entry = open({ card: claimed, session: prepared })
          prepared = undefined
          const waking = /^(wake|stall):/.test(id) && !opened && Boolean(entry.session)
          entry.activity = 'working'
          entry.input.push({ text: waking ? `${text}\n\n${digest()}` : text })

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
          allow: WORKER_COMMANDS,
          env: dispatch ? accountEnvironment({
            account: { provider: dispatch.provider, folder: dispatch.folder },
            env: environment({ task: target.id }),
          }) : environment({ task: target.id }),
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
              apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:dispatch` }, cardId: card.id, change: { type: 'task.launched', data: { via: 'pnyx', at: meta.at, folder: cwd, harness: dispatch.provider, dispatch: dispatch.reason, ...(dispatch.override ? { override: dispatch.override } : {}) } } }) })
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
        entry.sentAt = Date.now()
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

    permission: ({ task, request: id, choice, answer, actor, reason, details }) => {
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

          // Hydra runs pnyx-axi unasked, so it must not clear its own prompts with it.
          if (card.id === HYDRA_CARD && actor === HYDRA_ACTOR) {
            throw new HydraError({ message: 'Hydra cannot answer its own permission request', code: 'NO_ROUTE', help: ['The owner answers it in Hydra’s chat'] })
          }

          if (!waiting || waiting.card !== card.id || card.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
            writer.append({ event: permissionEvent({ state: writer.state, card, request: { ...request, status: 'expired' }, meta: { at: at(), actor: 'pnyx' } }) })

            return { expired: true as const }
          }

          const answered = choice === 'allow' && (request.questions || request.form || answer !== undefined)
            ? permissionAnswer({ request, value: answer })
            : {}
          const recorded = answered.answers
            ? { answers: answered.answers.map((picked, i) => request.questions?.[i]?.secret ? ['(hidden)'] : picked) }
            : answered
          writer.append({
            event: permissionEvent({
              state: writer.state,
              card,
              request: { ...request, status: choice, ...recorded },
              meta: { at: at(), actor, reason: why },
            }),
          })
          let posted: string | undefined

          const last = writer.state.hydraMessages?.at(-1)

          // ponytail: folds a run of allows on one task into its first line; the reasons stay in the task's history.
          if (actor === 'hydra' && choice === 'allow' && !request.questions && !request.form && last?.actor === HYDRA_ACTOR && last.task === card.id && last.text.startsWith(`${ALLOWED} `)) {
            posted = `none: folded into the previous ${ALLOWED} line`
          } else if (actor === 'hydra') {
            try {
              posted = postLine({ writer, hydraId, meta: { at: at(), actor, details }, cardId: card.id, action: `${request.questions || request.form ? (choice === 'allow' ? 'Answered' : 'Skipped') : choice === 'allow' ? ALLOWED : 'Denied'} ${request.tool} on ${card.title}`, reason: why })
            } catch (error) {
              posted = `none: ${(error as Error).message}`
            }
          }

          return {
            expired: false as const,
            answered,
            receipt: {
              task: card.id,
              request: id,
              status: choice,
              ...recorded,
              ...(posted ? { posted } : {}),
            },
          }
        },
      })

      if (result.expired) {
        waiting?.finish({ result: { behavior: 'deny', message: 'This permission request expired.' } })
        throw new HydraError({ message: 'the agent no longer waits for this request', code: 'PERMISSION_CLOSED' })
      }

      waiting?.finish({ result: choice === 'allow' ? { behavior: 'allow', ...result.answered } : { behavior: 'deny', message: why || 'Permission denied from Pnyx.' } })

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

    wake: ({ seq }) => {
      wakeStart ??= seq - 1
      wakeThrough = Math.max(wakeThrough, seq)
      armWake()
    },

    thread: ({ card, page }) => {
      const entry = card.agent && live.get(sessionId({ agent: card.agent }))

      return entry ? entry.replies.page({ page }) : page
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

    recover: () => {
      let resume: { id: string; text: string } | undefined

      write({
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
              const hydra = session.id === writer.state.config?.hydra.session
                && hostedHydra({ state: writer.state })
              const cut = hydra
                ? resumeTurn({ hydraId, state: writer.state, agent: session.agent }) : undefined
              resume ??= cut
              interrupt({ writer, agent: session.agent, note: 'Pnyx stopped during this turn. Send a message to continue it.', id: cut?.id })
            }
          }
        },
      })

      if (resume) {
        void host.hydra({ ...resume, actor: 'pnyx' })
      }

      // Changes made while the server was stopped wake Hydra once it is back.
      const state = loadHydra({ hydraId }).state

      if (hostedHydra({ state })) {
        const turns = Object.entries(state.eventIds).flatMap(([id, seq]) => id.endsWith(':hosted') ? [seq] : [])
        const after = wakeCursor({ state, fallback: Math.max(0, ...turns) })
        wakeStart = after
        const missed = readEvents({ hydraId })
          .findLast(event => event.seq > after && wakesHydra({ state, event }))

        if (missed) {
          host.wake({ seq: missed.seq })
        }
      }
    },

    close: () => {
      closing = true
      clearTimeout(wakeTimer)
      clearInterval(stallTimer)
      controller.abort()

      for (const [key, entry] of live) {
        retire({ key, entry })
      }
    },
  }

  return host
}

// Once per cut turn (its interruption records the resume id), and never a cut resume turn.
function resumeTurn({ hydraId, state, agent }: {
  hydraId: string
  state: HydraState
  agent: AgentRef
}): { id: string; text: string } | undefined {
  const events = readEvents({ hydraId })
  const cut = events.findLast(event => event.id.endsWith(':hosted'))
  const id = `resume:${cut?.seq}`

  if (!cut || cut.id.startsWith('resume:') || id in state.eventIds) {
    return undefined
  }

  const after = events.findLast(event => event.seq < cut.seq && event.type === 'card.pushed' && event.actor === 'pnyx'
    && event.data.activity === 'finished' && event.data.agent?.sessionId === agent.sessionId)?.seq ?? 0
  const messages = events.filter(event => event.seq > after && event.type === 'hydra.message' && event.actor !== HYDRA_ACTOR)
    .map(event => event.seq)
  const wake = /^(wake|stall):/.exec(cut.id)
  const handled = [
    ...(messages.length ? [`messages seq ${messages[0]}${messages.length > 1 ? ` to ${messages.at(-1)}` : ''}`] : []),
    ...(wake ? [`a ${wake[1]} check`] : []),
  ].join(' and ') || 'a turn'

  return { id, text: `<pnyx-wake>A Pnyx server restart cut your last turn before you answered ${handled}. Run \`pnyx-axi hydra messages --after ${after} --hydra ${hydraId}\` and \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\`, then answer what is still open; tell the owner in one line that the restart cut your reply.</pnyx-wake>` }
}

const providerName = ({ harness }: { harness: Harness }) => harness === 'codex' ? 'codex' : 'claude-code'

const modelsPath = () => join(pnyxHome(), 'harness-models.json')

// "<harness>:<login folder>" -> the harness's model list, shared by every Hydra.
function readModels(): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(modelsPath(), 'utf8')) as unknown

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function storedModels({ key }: { key: string }): ModelOption[] | undefined {
  const value = readModels()[key]
  const models = (Array.isArray(value) ? value as Partial<ModelOption>[] : [])
    .filter((model): model is ModelOption => typeof model?.value === 'string' && typeof model.label === 'string')

  return models.length > 0 ? models : undefined
}

// ponytail: read-modify-write without a lock, so two servers storing at once can drop one key; it is read again on the next start.
function storeModels({ key, models }: { key: string; models: ModelOption[] }): void {
  const tmp = `${modelsPath()}.tmp-${process.pid}`

  // The stored list only saves the next read; failing to write it never fails this one.
  try {
    writeFileSync(tmp, JSON.stringify({ ...readModels(), [key]: models }))
    renameSync(tmp, modelsPath())
  } catch {
    rmSync(tmp, { force: true })
  }
}

// A harness whose catalog cannot be read is left out, so its models are not checked.
async function catalogOffers({ host, harnesses }: { host: Host; harnesses: Harness[] }) {
  const offers: Partial<Record<Harness, string[]>> = {}

  await Promise.all([...new Set(harnesses)].map(harness => host.models({ harness })
    .then(models => {
      offers[harness] = modelIds({ models })
    }, () => {})))

  return offers
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
      const folder = field({ body, name: 'folder', optional: true })

      if (folder !== undefined && !isAbsolute(folder)) {
        throw new HydraError({ message: 'folder must be an absolute path', code: 'VALIDATION_ERROR' })
      }

      const task = field({ body, name: 'task' })!
      const current = loadHydra({ hydraId: host.hydraId }).state
      const project = findCard({ state: current, ref: task }).project
      const config = effectiveDispatch({ hydraId: host.hydraId, state: current })
      const rule = field({ body, name: 'rule', optional: true })
      const named = (ruleCandidates({ dispatch: config.dispatch, rule }) ?? []).filter(c => c.model)
      const dispatch = body.dispatch
        ? validateChoice({ value: body.dispatch, config, project })
        : chooseCandidate({
          config,
          project,
          rule,
          offers: await catalogOffers({ host, harnesses: named.map(c => c.harness) }),
        })

      // A setting changed after the start would reach only the next turn.
      const settings: Record<string, string> = {
        ...chosenSettings({ choice: dispatch }),
        provider: providerName({ harness: dispatch.provider }),
      }
      const running = current.cards[HYDRA_CARD]?.settings?.mode
      const chosen = hydraConfig({ state: current, id: host.hydraId }).hydra.agent
      // Only a mode the composer and the running Hydra agree on passes on, never one mid-switch.
      const hydraMode = hostedHydra({ state: current }) && (!chosen || chosen.mode === running)
        ? running : undefined

      // A rule without a mode inherits Hydra's; never plan, which would stall a worker.
      if (!settings.mode && hydraMode && hydraMode !== 'plan'
        && findOption({ provider: settings.provider, setting: 'mode', value: hydraMode, hosted: true })) {
        settings.mode = hydraMode
      }

      return host.start({ dispatch, task, prompt: field({ body, name: 'prompt' })!, folder, settings, replacement: field({ body, name: 'replacement', optional: true }), id: field({ body, name: 'id' })!, actor, reason: field({ body, name: 'reason', optional: true }) })
    }

    case 'models': {
      const harness = field({ body, name: 'harness' })

      if (harness !== 'claude' && harness !== 'codex') {
        throw new HydraError({ message: 'models expects claude or codex', code: 'VALIDATION_ERROR' })
      }

      return { models: await host.models({ harness }) }
    }

    case 'permission': {
      const choice = field({ body, name: 'choice' })

      if (choice !== 'allow' && choice !== 'deny') {
        throw new HydraError({ message: 'choice must be allow or deny', code: 'VALIDATION_ERROR' })
      }

      return host.permission({ task: field({ body, name: 'task' })!, request: field({ body, name: 'request' })!, choice, ...(body.answer !== undefined ? { answer: body.answer } : {}), actor, reason: field({ body, name: 'reason', optional: true }), details: field({ body, name: 'details', optional: true }) })
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
      throw new HydraError({ message: 'action must be hydra, start, models, continue, send, set or permission', code: 'VALIDATION_ERROR' })
  }
}
