import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import { hydraDelivery,QUIET_REPLY,reportActor } from './hydra.ts'
import { taskMentions } from './mentions.ts'
import type { HydraMessage } from './model.ts'
import type { ThreadEntry } from './transcripts-read.ts'
import { withoutInjected } from '#oracle/text.ts'
import { HYDRA_CARD } from './identity.ts'
import { restartCommand, upgradeCommand } from '#upgrade/model.ts'

export function leadingTask({ entry }: { entry: Pick<ThreadEntry, 'task' | 'text'> }) {
  if (!entry.task || entry.task === HYDRA_CARD) {
    return undefined
  }

  const mentioned = taskMentions({ text: entry.text }).some(mention => mention.id === entry.task)

  return mentioned ? undefined : entry.task
}

export const ownMessage = ({ entry }: { entry: ThreadEntry }) =>
  entry.kind === 'message' && [
    'user',
    'You',
  ].includes(entry.role)

export interface TurnTiming {
  start: string
  end: string
  reply: string
  // The task the reply opens with when its words don't mention it.
  task?: string
  latest: boolean
}

// Quiet reply prefixes hide only while text is streaming.
export const quietReply = ({ entry }: { entry: ThreadEntry }) => entry.kind === 'message' && entry.role.startsWith('assistant')
  && Boolean(entry.text.trim()) && (entry.streaming
  ? QUIET_REPLY.startsWith(entry.text.trim())
  : entry.text.trim() === QUIET_REPLY)

export const injectedInstructions = ({
  entry,
  provider,
}: {
  entry: ThreadEntry
  provider?: string
}) => provider === 'codex' && ownMessage({ entry }) && /^# AGENTS\.md instructions(?: for [^\n]*)?\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/.test(entry.text.trim())

export function hydraMessages({
  messages,
  transcript,
  provider,
  boundaries = false,
  waiting,
  receipts = true,
}: {
  messages: HydraMessage[]
  transcript: ThreadEntry[]
  provider?: string
  boundaries?: boolean
  // Why the owner's queued messages wait, when Pnyx knows.
  waiting?: string
  // Only a Hydra Pnyx runs reports when it took a message.
  receipts?: boolean
}): ThreadEntry[] {
  transcript = transcript.filter(entry => {
    const visible = boundaries || !quietReply({ entry })

    return visible && !injectedInstructions({
      entry,
      provider,
    })
  })
  const remaining = [...transcript]
  const normalized = ({ text }: { text: string }) => text.trim().replace(
    /\s+/g,
    ' ',
  )
  const recorded: ThreadEntry[] = [], replaced = new Set<ThreadEntry>()
  const owned: {
    message: HydraMessage
    entry: ThreadEntry
    copied: boolean
  }[] = []
  const rewritten = new Map<ThreadEntry, ThreadEntry>()
  const ownCopies = new Map(transcript.filter(entry => ownMessage({ entry })).map(entry => [
    entry,
    normalized(entry),
  ]))

  // A copy is known by what Pnyx delivered: reports never show, the owner's own words always do.
  for (const message of messages) {
    const report = reportActor({ actor: message.actor })
    const role = message.actor === HYDRA_ACTOR ? 'assistant' : message.actor === 'pnyx' ? 'Pnyx' : 'user'
    const text = message.details ? `${message.text}\n\n${message.details}` : message.text
    const entered = message.enteredText ?? message.text
    const shown = message.details ? `${entered}\n\n${message.details}` : entered
    const sent = message.context ? `${text}\n\n${message.context}` : text
    // An older server delivered a report as its bare words.
    const reportCopies = [
      hydraDelivery({ message }),
      text,
      sent,
    ]
    // The transcript reader drops harness markup the owner quoted.
    const ownerCopies = [
      text,
      sent,
      withoutInjected({ text }),
      withoutInjected({ text: sent }),
    ]
    const delivered = report ? reportCopies : ownerCopies
    const copies = new Set(delivered.map(copy => normalized({ text: copy })))
    const match = role === 'user' ? remaining.findIndex(entry => {
      const copy = ownCopies.get(entry)

      return copy !== undefined && copies.has(copy)
    }) : -1

    if (match >= 0) {
      const [entry] = remaining.splice(
        match,
        1,
      )

      if (report) {
        replaced.add(entry!)

        if (boundaries) {
          recorded.push({
            ...entry!,
            text: '',
            hidden: true,
          })
        }
      } else {
        const copy: ThreadEntry = {
          ...entry!,
          reference: message.id,
          text: shown,
        }

        if (message.task) {
          copy.task = message.task
        }

        if (ownerActor({ actor: message.actor })) {
          owned.push({
            message,
            entry: copy,
            copied: true,
          })
        }

        rewritten.set(
          entry!,
          copy,
        )
      }
    } else if (!report) {
      const entry: ThreadEntry = {
        id: message.id,
        reference: message.id,
        kind: message.kind === 'divider' ? 'divider' : 'message',
        role,
        final: message.actor === HYDRA_ACTOR ? true : undefined,
        text: shown,
        at: message.at,
        hidden: boundaries && message.kind !== 'divider' && (message.actor === 'pnyx' || !!message.fromMessage || message.id.endsWith(':line')),
        ...(message.task ? { task: message.task } : {}),
      }
      recorded.push(entry)

      if (role === 'user' && ownerActor({ actor: message.actor }) && !entry.hidden) {
        owned.push({
          message,
          entry,
          copied: false,
        })
      }
    }
  }

  // Hydra takes the owner's messages in order, so one sent before a received message no longer waits; with no recorded time, it shows no receipt.
  let laterReceived = false

  for (const {
    message,
    entry,
    copied,
  } of receipts ? owned.toReversed() : []) {
    entry.sent = message.at
    // Pnyx runs /restart and /upgrade itself, so they never reach the harness.
    const pnyxCommand = restartCommand({ text: message.text })
      || upgradeCommand({ text: message.text })

    if (pnyxCommand) {
      continue
    }

    // A transcript copy found by its text counts only when it comes after the send; an older message with the same words cannot take it.
    const copyTime = copied && entry.at && entry.at >= message.at ? entry.at : undefined
    const received = message.received ?? copyTime

    if (received) {
      entry.receipt = 'delivered'
      entry.received = received
      laterReceived = true
    } else if (!laterReceived) {
      entry.receipt = 'queued'

      if (waiting) {
        entry.waiting = waiting
      }
    }
  }

  return [
    ...recorded,
    ...transcript.filter(entry => !replaced.has(entry)).map(entry => rewritten.get(entry) ?? entry),
  ]
}
