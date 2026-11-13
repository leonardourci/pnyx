import { memoryConditions } from '#memory/conditions.ts'
import { setupCheck, setupDigest } from '#setup/check.ts'
import { projectDigest } from '#projects/context.ts'
import { queuePosition } from './queue.ts'
import { projectRows } from '#projects/read.ts'
import { hydraDigest } from '#hydra/digest.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { checkAttachments } from './presence.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { AxiError } from 'axi-sdk-js'
import { HYDRA_ACTOR, OWNER_ACTORS } from '#app/actors.ts'
import type { HydraEvent, EventType } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import type { Connect } from '#integrations/paseo/client.ts'
import { redact } from '#oracle/text.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { commandText } from '#integrations/hooks/observe.ts'
import { askWording, openAsks } from '#tasks/ask-state.ts'
import { lifecycleMove } from '#tasks/lifecycle.ts'
import { COMMON, guard, integer, parse, type Output, summarize } from '#app/cli-support.ts'
import { commands } from '#app/cli.ts'
import { requestEnv } from '#app/request-context.ts'
import { isManagedTask } from '#tasks/select.ts'
import { pendingPermissions } from './permission-rules.ts'
import { typedWords, type TypedWords } from './typed-words.ts'

const TRACKED: readonly EventType[] = [
  'task.queue',
  'task.dependencies',
  'task.reminder',
  'task.reminder-due',
  'hydra.project',
  'task.project',
  'task.permission',
  'hydra.message',
  'task.created',
  'task.held',
  'task.released',
  'task.kind',
  'task.report',
  'task.report-reviewed',
  'task.landing',
  'task.brief',
  'task.owner-ask',
  'task.intent',
  'task.visibility',
  'task.declared',
  'task.asked',
  'task.ask.escalated',
  'task.ask.closed',
  'task.ask.deferred',
  'task.ask.reopened',
  'task.session',
  'board.columns',
  'card.moved',
  'card.linked',
  'task.launched',
]
const CHECK_LIMIT = 20
const POLL_MS = 2000

export async function hydraCheck({
  args,
  connect,
}: {
  args: string[]
  connect?: Connect
}): Promise<Output> {
  const {
    values,
    hydraId,
  } = parse({
    args,
    options: {
      ...COMMON,
      after: { type: 'string' },
      wait: { type: 'string' },
    },
    positionals: 1,
  })
  const wait = integer({
    value: values.wait,
    flag: '--wait',
  }) ?? 0

  // A shell call inside a turn holds every message to Hydra until it returns; Pnyx wakes the Hydra it runs instead.
  if (wait > 0 && requestEnv().PNYX_HOSTED === 'hydra') {
    throw new AxiError(
      '--wait would block your turn, and the owner\'s messages with it; Pnyx wakes you when something changes',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi hydra check` without --wait, then end your turn'],
    )
  }

  if (wait > 3600) {
    throw new AxiError(
      '--wait is at most 3600 seconds',
      'VALIDATION_ERROR',
    )
  }

  const after = integer({
    value: values.after,
    flag: '--after',
  }) ?? loadHydra({ hydraId }).state.seq
  hydraDir({ hydraId })
  const deadline = Date.now() + wait * 1000
  const changes: HydraEvent[] = []
  let woken = false
  let offset = 0
  let last = after
  // Words typed into a worker's session count once an event follows them, between the times
  // of the events at after and at the last seq read, so a check from that seq never repeats them.
  let from = -Infinity
  let to = -Infinity
  const replies: HydraEvent[] = []
  let typed: TypedWords[] = []

  do {
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        harvestTranscripts({
          writer,
          cardIds: Object.values(writer.state.cards)
            .filter(c => !isManagedTask({ card: c }) && c.sessionIds?.length)
            .map(c => c.id),
          at: new Date().toISOString(),
        })
      },
    })
    const read = readEventsFrom({
      hydraId,
      offset,
    })

    if (read) {
      offset = read.end
      const current = loadHydra({ hydraId }).state

      for (const e of read.events) {
        last = Math.max(
          last,
          e.seq,
        )
        to = Math.max(
          to,
          Date.parse(e.at),
        )

        if (e.seq === after) {
          from = to
        }

        if (e.type === 'card.replied' && e.data.state === 'queued' && e.data.text) {
          replies.push(e)
        }

        const task = current.cards[e.cardId]
        const worker = task?.tracking === 'declared' && !isManagedTask({ card: task })
        const question = worker && e.type === 'card.pushed' && e.data.attention?.some(a => a.blocking && !a.answered)
        const owner = e.type === 'card.replied' && e.cardId !== '$hydra' && e.data.state === 'queued' && Boolean(e.data.text?.trim()) && !e.data.control && e.actor !== HYDRA_ACTOR
        const listed = TRACKED.includes(e.type) && !lifecycleMove({ id: e.id })
        const tracked = listed || question || owner

        // Hydra's own chat lines are listed so it rereads what it said and why, but never wake it.
        const own = e.type === 'hydra.message' && e.actor === HYDRA_ACTOR

        if (e.seq > after && ((tracked && e.actor !== HYDRA_ACTOR) || own)) {
          changes.push(e)
          woken ||= !own
        }
      }

      typed = typedWords({
        state: current,
        replies,
        from,
        to,
      })

      if (typed.length) {
        woken = true
      }
    }

    if (woken || Date.now() >= deadline) {
      break
    }

    await sleep(Math.min(
      POLL_MS,
      deadline - Date.now(),
    ))
  } while (!woken)

  const page = changes.slice(
    0,
    CHECK_LIMIT,
  )
  const paged = changes.length > CHECK_LIMIT
  const through = paged ? page.at(-1)!.seq : last

  if (paged) {
    typed = typed.filter(words => Date.parse(words.at) < Date.parse(page.at(-1)!.at))
  }

  type Conversation = {
    task: string
    messages: {
      seq?: number
      at?: string
      role: string
      text: string
    }[]
  }
  const digest = new Map<string, Conversation>()

  for (const event of page) {
    const message = event.type === 'card.replied' && event.data.text
      ? {
        role: 'user',
        text: event.data.text,
      } : undefined

    if (message) {
      const task = digest.get(event.cardId) ?? {
        task: event.cardId,
        messages: [],
      }
      task.messages.push({
        seq: event.seq,
        role: message.role,
        text: compact({ text: message.text }),
      })
      digest.set(
        event.cardId,
        task,
      )
    }
  }

  for (const words of typed) {
    const task = digest.get(words.task) ?? {
      task: words.task,
      messages: [],
    }
    task.messages.push({
      at: words.at,
      role: 'user',
      text: compact({ text: words.text }),
    })
    digest.set(
      words.task,
      task,
    )
  }

  const directWordsHelp: string[] = []

  if (digest.size) {
    directWordsHelp.push('The owner’s direct words are instructions. Use task history --full for the complete replies; decide whether to act or take note.')
  }

  const typedHelp: string[] = []

  if (typed.length) {
    typedHelp.push(`Words with a time were typed into the worker's session; \`pnyx-axi task chat <task> --hydra ${hydraId}\` shows them whole`)
  }

  const row = ({ e }: { e: HydraEvent }) => ({
    seq: e.seq,
    id: e.id,
    type: e.type,
    task: e.cardId === '$board' ? 'none' : e.cardId,
    action: e.type === 'hydra.message' ? e.data.action : 'none',
    actor: OWNER_ACTORS.includes(e.actor) ? `owner (${e.actor})` : e.actor,
    summary: compact({
      text: e.type === 'card.pushed' ? e.data.attention?.filter(a => a.blocking && !a.answered)
        .map(a => a.text ?? a.kind)
        .join('; ') ?? 'Agent needs an answer' : summarize({ event: e }),
    }),
  })

  const state = loadHydra({ hydraId }).state
  const requests = Object.values(state.cards).flatMap(card => pendingPermissions({ card })
    .map(p => ({
      id: p.id,
      task: card.id,
      tool: p.tool,
      command: compact({
        text: commandText({ input: p.input }) ?? [
          p.input.file_path,
          p.input.path,
        ].find(v => typeof v === 'string') ?? p.description ?? JSON.stringify(p.input),
      }),
      age: p.at ? `${Math.max(
        0,
        Math.round((Date.now() - Date.parse(p.at)) / 1000),
      )}s` : 'unknown',
    })))

  const asks = Object.values(state.cards).flatMap(card => openAsks({ card }).map(ask => ({
    id: ask.id,
    task: card.id,
    from: ask.actor,
    to: ask.audience,
    question: compact({ text: askWording({ ask }).question }),
    age: `${Math.max(
      0,
      Math.round((Date.now() - Date.parse(ask.at)) / 1000),
    )}s`,
  })))

  return {
    hydraId,
    projects: projectRows({ state }),
    changes: page.length ? page.map(e => row({ e })) : `none: nothing Hydra tracks changed after seq ${after}`,
    through,
    queues: Object.values(state.cards).filter(card => card.queue)
      .map(card => ({
        task: card.id,
        ...queuePosition({
          state,
          card,
        }),
      })),
    requests: requests.length ? requests : 'none: no open permission requests',
    questions: asks.length ? asks : 'none: no open questions',
    agents: await checkAttachments({
      state,
      connect,
    }),
    ...(digest.size ? { conversations: [...digest.values()] } : {}),
    help: [
      ...directWordsHelp,
      ...typedHelp,
      ...(asks.some(ask => ask.to === 'hydra') ? [`Answer a worker's question with \`pnyx-axi task answer <task> <question> --choice <n> | --text "<answer>" --actor hydra --reason "<why>" --hydra ${hydraId}\`, or hand an owner decision on with \`task escalate\`; questions to the owner wait for the owner`] : []),
      ...(requests.length ? [`Answer a worker's request with \`pnyx-axi task permission <task> <id> allow|deny --actor hydra --reason "<why>" --hydra ${hydraId}\`; requests on $hydra wait for the owner`] : []),
      `Run \`pnyx-axi hydra check --after ${through} --wait 1800 --hydra ${hydraId}\` to wait for the next change`,
    ],
  }
}

function compact({ text }: { text: string }): string {
  const clean = redact({ text }).replace(
    /\s+/g,
    ' ',
  )
    .trim()

  return clean.length > 280 ? `${clean.slice(
    0,
    279,
  )}…` : clean
}

// guard catches only synchronous errors; the check can wait.
const hydraCheckHandler = guard({
  handler: ({ args }) => hydraCheck({ args }).catch((error: unknown) => {
    if (error instanceof HydraError) {
      throw new AxiError(
        error.message,
        error.code,
        error.help,
      )
    }

    throw error
  }),
})

const hydraDigestHandler = guard({
  handler: async ({ args }) => {
    const { hydraId } = parse({
      args,
      options: COMMON,
      positionals: 1,
    })

    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state
    const [
      projects,
      items,
    ] = await Promise.all([
      projectDigest({ state }),
      setupCheck({
        hydraId,
        state,
      }),
    ])

    return hydraDigest({
      conditions: memoryConditions(),
      hydraId,
      owner,
      state,
      projects,
      setup: setupDigest({ items }),
    })
  },
})

export const workerCommands = {
  hydra: guard({
    handler: ({ args }) => (args[0] === 'check' ? hydraCheckHandler(args) : args[0] === 'digest' ? hydraDigestHandler(args) : commands.hydra(args)),
  }),
}
