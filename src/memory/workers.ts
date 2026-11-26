import { inform } from '#app/command-notices.ts'
import { titanConfig } from '#titan/config.ts'
import { titanEvent } from '#titan/titan.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Writer } from '#app/writer.ts'

const WORKER_NOTES_BUDGET = 1500

export function checkWorkerNotes({
  text,
  reason,
}: {
  text: string | null
  reason?: string
}): void {
  if (!reason?.trim()) {
    inform({
      reason: 'Worker instructions changed without a reason',
      clear: 'Review the standing worker instructions and record why they changed',
    })
  }

  if (text !== null && text.length > WORKER_NOTES_BUDGET) {
    inform({
      reason: `Standing worker instructions exceed ${WORKER_NOTES_BUDGET} characters`,
      clear: 'Shorten the standing worker instructions and record why they changed',
    })
  }
}

export function workerNotesNotice({
  writer,
  target,
  meta,
}: {
  writer: Writer
  target: string
  meta: Meta & { id: string }
}): void {
  const id = `${meta.id}:worker-notes-notice`

  if (writer.state.eventIds[id] !== undefined) {
    return
  }

  const decision = titanEvent({
    state: writer.state,
    cardId: '$all',
    meta: {
      id,
      at: meta.at,
      actor: 'othrys',
    },
    change: {
      type: 'titan.message',
      data: {
        action: 'send',
        titan: titanConfig({ state: writer.state }).titan.id,
        text: `Standing worker instructions for ${target} changed${meta.reason?.trim() ? `: ${meta.reason.trim()}` : ''}`,
      },
    },
  })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}
