import { hydraConfig } from '../hydra/config.ts'
import { hydraEvent } from '../hydra/hydra.ts'
import { HydraError } from '../store/errors.ts'
import type { Meta } from '../app/command-meta.ts'
import type { Writer } from '../app/writer.ts'

export const WORKER_NOTES_BUDGET = 1500

export function checkWorkerNotes({
  text,
  reason,
}: {
  text: string | null
  reason?: string
}): void {
  if (!reason?.trim()) {
    throw new HydraError({
      message: 'Standing worker instruction changes need --reason <why>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (text !== null && text.length > WORKER_NOTES_BUDGET) {
    throw new HydraError({
      message: `Standing worker instructions exceed ${WORKER_NOTES_BUDGET} characters`,
      code: 'MEMORY_FULL',
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
        text: `Standing worker instructions for ${target} changed: ${meta.reason}`,
      },
    },
  })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}
