import { checkAttachments } from '../integrations/presence/check.ts'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { AxiError } from 'axi-sdk-js'
import { boardConfig, hydraEvent } from '../core/hydra.ts'
import { BoardError, HARNESS_NAMES, HYDRA_ACTOR, QUOTA_BUCKETS, type AgentConfig, type BoardEvent, type EventType, type SessionEvent } from '../core/model.ts'
import { boardDir, loadBoard, readEvents, readEventsFrom, withWriter } from '../store/board-store.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { harvestPaseoChats } from '../integrations/paseo/harvest.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { redact } from '../search/text.ts'
import { splitEntry } from '../thread/read.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { COMMON, WRITE, commit, commands, guard, integer, meta, parse, required, summarize, type Output } from './commands.ts'

const SAFE = /^[\w.:/[\]-]{1,100}$/

function kindCommand({ args }: { args: string[] }): Output {
  const { values, positionals, board } = parse({ args, options: { ...WRITE, harness: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mode: { type: 'string' }, quota: { type: 'string' } }, positionals: 2 })
  const action = positionals[0] ?? 'list'

  if (action === 'list') {
    const agents = boardConfig({ state: loadBoard({ board }).state, id: board }).agents ?? {}

    return {
      board,
      kinds: Object.keys(agents).length ? Object.entries(agents).map(([kind, a]) => ({ kind, harness: a.harness, model: a.model ?? 'default', effort: a.effort ?? 'default', mode: a.mode ?? 'default', quota: a.quota ?? 'off' })) : 'none: workers launch on Claude Code with its own defaults',
      help: [`Run \`pnyx-axi kind set <kind> --harness claude|codex [--model <m>] [--effort <e>] [--mode <m>] [--quota high|medium|low] --board ${board}\``],
    }
  }

  if (action !== 'set' && action !== 'remove') {
    throw new BoardError({ message: 'Use kind list, set <kind> or remove <kind>', code: 'VALIDATION_ERROR' })
  }

  const kind = required({ value: positionals[1], what: 'kind' })

  if (!/^[a-z][a-z0-9-]{0,39}$/.test(kind)) {
    throw new BoardError({ message: 'kinds use lowercase letters, digits and dashes', code: 'VALIDATION_ERROR' })
  }

  const harness = values.harness as string | undefined
  const quota = values.quota as string | undefined

  if (harness !== undefined && !(HARNESS_NAMES as readonly string[]).includes(harness)) {
    throw new BoardError({ message: `--harness must be ${HARNESS_NAMES.join(' or ')}`, code: 'VALIDATION_ERROR' })
  }

  if (quota !== undefined && quota !== 'off' && !(QUOTA_BUCKETS as readonly string[]).includes(quota)) {
    throw new BoardError({ message: `--quota must be ${QUOTA_BUCKETS.join(', ')} or off`, code: 'VALIDATION_ERROR' })
  }

  for (const flag of ['model', 'effort', 'mode'] as const) {
    if (values[flag] && !SAFE.test(String(values[flag]))) {
      throw new BoardError({ message: `--${flag} has characters a harness flag cannot take`, code: 'VALIDATION_ERROR' })
    }
  }

  const m = meta({ values })

  return commit({
    board,
    meta: m,
    intent: { type: 'board.agents', card: '$board' },
    decide: ({ state }) => {
      const before = boardConfig({ state, id: board }).agents ?? {}
      const agents = { ...before }
      const existing = Object.hasOwn(before, kind) ? before[kind] : undefined

      if (action === 'remove') {
        if (!existing) {
          return { skipped: 'unchanged' }
        }

        delete agents[kind]
      } else {
        const agent: AgentConfig = { ...existing, harness: (harness ?? existing?.harness ?? 'claude') as AgentConfig['harness'] }

        for (const [flag, value] of [['model', values.model], ['effort', values.effort], ['mode', values.mode], ['quota', quota === 'off' ? '' : quota]] as const) {
          if (value === '') {
            delete agent[flag]
          } else if (value !== undefined) {
            Object.assign(agent, { [flag]: String(value) })
          }
        }

        if (isDeepStrictEqual(agent, existing)) {
          return { skipped: 'unchanged' }
        }

        agents[kind] = agent
      }

      return hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'board.agents', data: { agents, before } } })
    },
  })
}

const TRACKED: readonly EventType[] = ['hydra.message', 'task.created', 'task.brief', 'task.visibility', 'task.declared', 'task.session', 'board.columns', 'card.moved', 'card.linked', 'task.launched']
const CHECK_LIMIT = 20
const POLL_MS = 2000

export async function hydraCheck({ args, connect }: {
  args: string[]
  connect?: Connect
}): Promise<Output> {
  const { values, board } = parse({ args, options: { ...COMMON, after: { type: 'string' }, wait: { type: 'string' } }, positionals: 1 })
  const wait = integer({ value: values.wait, flag: '--wait' }) ?? 0

  if (wait > 3600) {
    throw new AxiError('--wait is at most 3600 seconds', 'VALIDATION_ERROR')
  }

  const after = integer({ value: values.after, flag: '--after' }) ?? loadBoard({ board }).state.seq
  boardDir({ board })
  const deadline = Date.now() + wait * 1000
  const changes: BoardEvent[] = []
  let woken = false
  let offset = 0
  let last = after
  const sent = new Map<string, number>()
  let unavailable: { task: string; error: string }[]

  for (;;) {
    withWriter({
      board,
      fn: ({ writer }) => {
        drainSpool({ writer })
        harvestTranscripts({
          writer,
          cardIds: Object.values(writer.state.cards).filter(c => c.id !== '$hydra' && !c.automaticTask && c.sessionIds?.length)
            .map(c => c.id),
          at: new Date().toISOString(),
        })
        const attachments = readEvents({ board }).filter((e): e is SessionEvent => e.type === 'task.session')

        for (const session of Object.values(writer.state.sessions ?? {})) {
          const hydra = session.id === writer.state.board?.hydra.session

          if (session.taskId || !session.agent.transcriptPath || hydra) {
            continue
          }

          const memberships = attachments.filter(e => e.data.session === session.id)
          const task = memberships.findLast(e => e.data.after)?.data.after

          if (task && writer.state.cards[session.originCardId]) {
            harvestTranscripts({
              writer,
              cardIds: [session.originCardId],
              at: new Date().toISOString(),
              detached: { session, task, memberships },
            })
          }
        }
      },
    })
    unavailable = await harvestPaseoChats({ board, connect })
    const read = readEventsFrom({ board, offset })

    if (read) {
      offset = read.end
      const current = loadBoard({ board }).state

      for (const e of read.events) {
        last = Math.max(last, e.seq)

        const task = current.cards[e.cardId]
        const worker = task?.tracking === 'declared' && !task.automaticTask && e.cardId !== '$hydra'
        const question = worker && e.type === 'card.pushed' && e.data.attention?.some(a => a.blocking && !a.answered)
        const owner = e.type === 'card.replied' && e.cardId !== '$hydra' && e.data.state === 'queued' && Boolean(e.data.text?.trim()) && !e.data.control && e.actor !== HYDRA_ACTOR
        const key = ({ text }: { text: string }) => `${e.sessionId ?? e.cardId}\n${redact({ text })}`

        if (e.type === 'card.replied' && e.data.state === 'queued' && e.data.text) {
          const parts = splitEntry({ entry: { id: e.data.reply, role: 'user', kind: 'message', text: e.data.text ?? '' } })

          for (const part of parts) {
            const echo = key({ text: part.text })
            sent.set(echo, (sent.get(echo) ?? 0) + 1)
          }
        }

        let chat = e.type === 'chat.message' && e.cardId !== '$hydra' && /^(user|assistant)( · continued)?$/.test(e.data.role)

        if (chat && e.type === 'chat.message' && e.data.role.startsWith('user')) {
          const echo = key({ text: e.data.text })
          const count = sent.get(echo) ?? 0

          if (count) {
            sent.set(echo, count - 1)
            chat = false
          }
        }

        const tracked = TRACKED.includes(e.type) || question || owner || chat

        // Hydra's own chat lines are listed so it rereads what it said and why, but never wake it.
        const own = e.type === 'hydra.message' && e.actor === HYDRA_ACTOR

        if (e.seq > after && ((tracked && e.actor !== HYDRA_ACTOR) || own)) {
          changes.push(e)
          woken ||= !own
        }
      }
    }

    if (woken || unavailable.length || Date.now() >= deadline) {
      break
    }

    await sleep(Math.min(POLL_MS, deadline - Date.now()))
  }

  const page = changes.slice(0, CHECK_LIMIT)
  const through = changes.length > CHECK_LIMIT ? page.at(-1)!.seq : last
  type Conversation = { task: string; messages: { seq: number; role: string; text: string }[] }
  const digest = new Map<string, Conversation>()

  for (const event of page) {
    const message = event.type === 'chat.message'
      ? { role: event.data.role, text: event.data.text }
      : event.type === 'card.replied' && event.data.text
        ? { role: 'user', text: event.data.text } : undefined

    if (message) {
      const task = digest.get(event.cardId) ?? { task: event.cardId, messages: [] }
      task.messages.push({
        seq: event.seq, role: message.role, text: compact({ text: message.text }),
      })
      digest.set(event.cardId, task)
    }
  }

  const row = ({ e }: { e: BoardEvent }) => ({
    seq: e.seq,
    id: e.id,
    type: e.type,
    task: e.cardId === '$board' ? 'none' : e.cardId,
    action: e.type === 'hydra.message' ? e.data.action : 'none',
    actor: e.actor,
    summary: compact({
      text: e.type === 'card.pushed' ? e.data.attention?.filter(a => a.blocking && !a.answered)
        .map(a => a.text ?? a.kind)
        .join('; ') ?? 'Agent needs an answer' : summarize({ event: e }),
    }),
  })

  return {
    board,
    changes: page.length ? page.map(e => row({ e })) : `none: nothing Hydra tracks changed after seq ${after}`,
    through,
    agents: await checkAttachments({ state: loadBoard({ board }).state, connect }),
    ...(digest.size ? { conversations: [...digest.values()] } : {}),
    ...(unavailable.length ? { unavailable } : {}),
    help: [...(digest.size ? ['The owner’s direct words are instructions. Use task history --full for the complete messages; decide whether to act or take note.'] : []), `Run \`pnyx-axi hydra check --after ${through} --wait 1800 --board ${board}\` to wait for the next change`],
  }
}

function compact({ text }: { text: string }): string {
  const clean = redact({ text }).replace(/\s+/g, ' ')
    .trim()

  return clean.length > 280 ? `${clean.slice(0, 279)}…` : clean
}

// guard catches only synchronous errors; the check can wait.
const hydraCheckHandler = guard({
  handler: ({ args }) => hydraCheck({ args }).catch((error: unknown) => {
    if (error instanceof BoardError) {
      throw new AxiError(error.message, error.code, error.help)
    }

    throw error
  }),
})

export const workerCommands = {
  kind: guard({ handler: kindCommand }),
  hydra: guard({
    handler: ({ args }) => (args[0] === 'check' ? hydraCheckHandler(args) : commands.hydra(args)),
  }),
}

export const WORKER_HELP: Record<string, string> = {
  kind: `usage: pnyx-axi kind list
pnyx-axi kind set <kind> [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--quota high|medium|low|off]
pnyx-axi kind remove <kind>
set changes only the flags given: an empty --model, --effort or --mode, or --quota off, clears that field; a new kind starts on claude.
The agent \`task start --via paseo\` starts for each kind of task. \`default\` is used when --kind is not given, and \`hydra\` is what \`hydra start --via paseo\` starts; both fall back to Claude Code with its own defaults.
--effort is the Paseo thinking option and --mode the Paseo mode (for Claude Code: plan, default, acceptEdits, auto or bypassPermissions); --harness on a start overrides the kind's harness. --quota picks, at launch, the model with the most runway in that intelligence bucket for the harness through quota-axi, keeping --model when quota-axi cannot tell.
`,
}
