import { randomUUID } from 'node:crypto'
import type { Writer } from '../store/hydra-store.ts'
import type { CompactionChange } from './model.ts'

export function recordCompaction({
  writer,
  card,
  change,
  at,
}: {
  writer: Writer
  card: string
  change: CompactionChange
  at: string
}) {
  writer.append({
    event: {
      v: 1,
      id: randomUUID(),
      seq: writer.state.seq + 1,
      cardId: card,
      actor: 'pnyx',
      at,
      type: 'session.compaction',
      data: change,
    },
  })
}
