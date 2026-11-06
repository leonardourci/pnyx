import { readTranscriptRecord } from '#workers/transcripts.ts'

export { codexThreadTitle } from '#workers/codex.ts'

export function transcriptNotes({ record }: { record: unknown }) {
  return readTranscriptRecord({ record }).notes
}
