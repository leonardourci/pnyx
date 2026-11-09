import { HYDRA_ACTOR } from '#app/actors.ts'
import { hydraDelivery,QUIET_REPLY,reportActor } from './hydra.ts'
import { taskMentions } from './mentions.ts'
import type { HydraMessage } from './model.ts'
import type { ThreadEntry } from './transcripts-read.ts'
import { withoutInjected } from '#oracle/text.ts'

export function leadingTask({ entry }: { entry: Pick<ThreadEntry, 'task' | 'text'> }) {
  if (!entry.task) {
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
}: {
  messages: HydraMessage[]
  transcript: ThreadEntry[]
  provider?: string
  boundaries?: boolean
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

        rewritten.set(
          entry!,
          copy,
        )
      }
    } else if (!report) {
      recorded.push({
        id: message.id,
        reference: message.id,
        kind: message.kind === 'divider' ? 'divider' : 'message',
        role,
        final: message.actor === HYDRA_ACTOR ? true : undefined,
        text: shown,
        at: message.at,
        hidden: boundaries && message.kind !== 'divider' && (message.actor === 'pnyx' || !!message.fromMessage || message.id.endsWith(':line')),
        ...(message.task ? { task: message.task } : {}),
      })
    }
  }

  return [
    ...recorded,
    ...transcript.filter(entry => !replaced.has(entry)).map(entry => rewritten.get(entry) ?? entry),
  ]
}
