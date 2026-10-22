import { setupCheck, setupDigest } from '../setup/check.ts'
import { projectDigest } from '../projects/context.ts'
import { queuePosition } from '../queue/state.ts'
import { projectRows } from '../projects/read.ts'
import { hydraDigest } from '../core/digest.ts'
import { ownerMemory } from '../store/owner-memory.ts'
import { checkAttachments } from '../integrations/presence/check.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { AxiError } from 'axi-sdk-js'
import { HydraError, HYDRA_ACTOR, OWNER_ACTORS, type HydraEvent, type EventType, type SessionEvent } from '../core/model.ts'
import { hydraDir, loadHydra, readEvents, readEventsFrom, withWriter } from '../store/hydra-store.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { harvestPaseoChats } from '../integrations/paseo/harvest.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { redact } from '../oracle/text.ts'
import { splitEntry } from '../thread/read.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { commandText } from '../integrations/hooks/observe.ts'
import { lifecycleMove } from '../core/lifecycle.ts'
import { COMMON, commands, guard, integer, parse, summarize, type Output } from './commands.ts'

const TRACKED: readonly EventType[] = [
  'task.queue',
  'task.reminder',
  'task.reminder-due',
  'hydra.project',
  'task.project',
  'task.permission',
  'hydra.message',
  'task.created',
  'task.brief',
  'task.visibility',
  'task.declared',
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
  const sent = new Map<string, number>()
  let unavailable: {
    task: string
    error: string
  }[]

  for (;;) {
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        harvestTranscripts({
          writer,
          cardIds: Object.values(writer.state.cards).filter(c => c.id !== '$hydra' && !c.automaticTask && c.sessionIds?.length)
            .map(c => c.id),
          at: new Date().toISOString(),
        })
        const attachments = readEvents({ hydraId }).filter((e): e is SessionEvent => e.type === 'task.session')

        for (const session of Object.values(writer.state.sessions ?? {})) {
          const hydra = session.id === writer.state.config?.hydra.session

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
              detached: {
                session,
                task,
                memberships,
              },
            })
          }
        }
      },
    })
    unavailable = await harvestPaseoChats({
      hydraId,
      connect,
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

        const task = current.cards[e.cardId]
        const worker = task?.tracking === 'declared' && !task.automaticTask && e.cardId !== '$hydra'
        const question = worker && e.type === 'card.pushed' && e.data.attention?.some(a => a.blocking && !a.answered)
        const owner = e.type === 'card.replied' && e.cardId !== '$hydra' && e.data.state === 'queued' && Boolean(e.data.text?.trim()) && !e.data.control && e.actor !== HYDRA_ACTOR
        const key = ({ text }: { text: string }) => `${e.sessionId ?? e.cardId}\n${redact({ text })}`

        if (e.type === 'card.replied' && e.data.state === 'queued' && e.data.text) {
          const parts = splitEntry({
            entry: {
              id: e.data.reply,
              role: 'user',
              kind: 'message',
              text: [
                e.data.text,
                e.data.context,
              ].filter(Boolean).join('\n\n'),
            },
          })

          for (const part of parts) {
            const echo = key({ text: part.text })
            sent.set(
              echo,
              (sent.get(echo) ?? 0) + 1,
            )
          }
        }

        let chat = e.type === 'chat.message' && e.cardId !== '$hydra' && /^(user|assistant)( · continued)?$/.test(e.data.role)

        if (chat && e.type === 'chat.message' && e.data.role.startsWith('user')) {
          const echo = key({ text: e.data.text })
          const count = sent.get(echo) ?? 0

          if (count) {
            sent.set(
              echo,
              count - 1,
            )
            chat = false
          }
        }

        const listed = TRACKED.includes(e.type) && !lifecycleMove({ id: e.id })
        const tracked = listed || question || owner || chat

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

    await sleep(Math.min(
      POLL_MS,
      deadline - Date.now(),
    ))
  }

  const page = changes.slice(
    0,
    CHECK_LIMIT,
  )
  const through = changes.length > CHECK_LIMIT ? page.at(-1)!.seq : last
  type Conversation = {
    task: string
    messages: {
      seq: number
      role: string
      text: string
    }[]
  }
  const digest = new Map<string, Conversation>()

  for (const event of page) {
    const message = event.type === 'chat.message'
      ? {
        role: event.data.role,
        text: event.data.text,
      }
      : event.type === 'card.replied' && event.data.text
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
  const requests = Object.values(state.cards).flatMap(card => (card.permissions ?? [])
    .filter(p => p.status === 'pending')
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
    agents: await checkAttachments({
      state,
      connect,
    }),
    ...(digest.size ? { conversations: [...digest.values()] } : {}),
    ...(unavailable.length ? { unavailable } : {}),
    help: [
      ...(digest.size ? ['The owner’s direct words are instructions. Use task history --full for the complete messages; decide whether to act or take note.'] : []),
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
  handler: ({ args }) => {
    const { hydraId } = parse({
      args,
      options: COMMON,
      positionals: 1,
    })

    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state

    return hydraDigest({
      hydraId,
      owner,
      state,
      projects: projectDigest({ state }),
      setup: setupDigest({
        items: setupCheck({
          hydraId,
          state,
        }),
      }),
    })
  },
})

export const workerCommands = {
  hydra: guard({
    handler: ({ args }) => (args[0] === 'check' ? hydraCheckHandler(args) : args[0] === 'digest' ? hydraDigestHandler(args) : commands.hydra(args)),
  }),
}
