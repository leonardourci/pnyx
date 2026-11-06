import { readClaudeTranscript } from './claude.ts'
import { readCodexTranscript } from './codex.ts'
import type { TranscriptReader, TranscriptRecord } from './provider.ts'

const readers: TranscriptReader[] = [
  readCodexTranscript,
  readClaudeTranscript,
]

export function readTranscriptRecord({
  record,
  subagent = false,
}: Parameters<TranscriptReader>[0]): TranscriptRecord {
  for (const read of readers) {
    const parsed = read({
      record,
      subagent,
    })

    if (parsed) {
      return parsed
    }
  }

  return {
    role: 'undefined',
    messages: [],
    traces: [],
    calls: [],
    results: [],
    notes: [],
  }
}

export function transcriptMessages({
  record,
  includeInternal = false,
}: {
  record: unknown
  includeInternal?: boolean
}) {
  const parsed = readTranscriptRecord({ record })

  return parsed.messages.filter(message => includeInternal || !message.internal)
}
