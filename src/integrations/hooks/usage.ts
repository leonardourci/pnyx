import { transcriptProvider } from '#workers/usage.ts'
import type { RecordedUsage, TranscriptUsageReader } from '#workers/provider.ts'

export type { RecordedUsage } from '#workers/provider.ts'

export interface UsageReader extends TranscriptUsageReader {
  provider: string
  read({
    reader,
    value,
  }: {
    reader: TranscriptUsageReader
    value: unknown
  }): void
}

export const usageReader = ({ provider }: { provider: string }): UsageReader => ({
  provider,
  read: transcriptProvider({ provider }),
  rows: [],
  messages: new Map(),
  previousTotal: 0,
  tasks: [],
  current: {},
})

export function readUsage({
  reader,
  value,
}: {
  reader: UsageReader
  value: unknown
}): void {
  reader.read({
    reader,
    value,
  })
}

export function recordedUsage({
  provider,
  records,
}: {
  provider: string
  records: unknown[]
}): RecordedUsage[] {
  const reader = usageReader({ provider })

  for (const value of records) {
    readUsage({
      reader,
      value,
    })
  }

  return reader.rows
}
