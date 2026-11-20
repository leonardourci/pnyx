import { inform } from '#app/command-notices.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Writer } from '#app/writer.ts'

export const WORKER_NOTES_BUDGET = 1500

export function checkWorkerNotes({
  text,
  reason,
  command = 'pnyx-axi hydra worker-notes set',
}: {
  text: string | null
  reason?: string
  command?: string
}): void {
  if (!reason?.trim()) {
    inform({
      reason: 'Worker instructions changed without a reason',
      clear: `Use ${command} --text "<instructions>" --reason "<why>"`,
    })
  }

  if (text !== null && text.length > WORKER_NOTES_BUDGET) {
    inform({
      reason: `Standing worker instructions exceed ${WORKER_NOTES_BUDGET} characters`,
      clear: `Use ${command} --text "<shorter instructions>" --reason "<why>"`,
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

  const decision = hydraEvent({
    state: writer.state,
    cardId: '$board',
    meta: {
      id,
      at: meta.at,
      actor: 'pnyx',
    },
    change: {
      type: 'hydra.message',
      data: {
        action: 'send',
        hydra: hydraConfig({ state: writer.state }).hydra.id,
        text: `Standing worker instructions for ${target} changed${meta.reason?.trim() ? `: ${meta.reason.trim()}` : ''}`,
      },
    },
  })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}
