import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Meta } from '../app/command-meta.ts'
import type { SteeringClaim } from '../workers/model.ts'
import type { Writer } from '../app/writer.ts'
import type { ExternalSource } from './model.ts'
import { lavishCanRearm } from './lavish-output.ts'
import {
  commandIdentity, handleResult, invalidSource, registerSource, SOURCE_MAX_BYTES,
  SOURCE_MAX_TIMEOUT_MS, sourceById, sourceTask,
} from './sources.ts'

const MAX_REPLY_BYTES = 32_768
const REPLY_AND_POLL_RUNS = 2

export function armLavish({
  writer,
  ref,
  id,
  page,
  executable,
  replyFile,
  after,
  sequence,
  claim,
  meta,
  worker,
}: {
  writer: Writer
  ref: string
  id: string
  page: string
  executable: string
  replyFile?: string
  after?: string
  sequence?: number
  claim?: SteeringClaim
  meta: Meta
  worker?: string
}): ExternalSource {
  const card = sourceTask({
    writer,
    ref,
    meta,
    worker,
  })
  const canonicalPage = realpathSync(page)

  if (!statSync(canonicalPage).isFile()) {
    invalidSource({ message: 'Lavish page must be an existing file' })
  }

  const lavish: NonNullable<ExternalSource['lavish']> = { page: canonicalPage }

  if (replyFile) {
    const text = readFileSync(
      replyFile,
      'utf8',
    )

    if (!text.trim() || Buffer.byteLength(text) > MAX_REPLY_BYTES || text.includes('\0')) {
      invalidSource({ message: `Use a nonempty agent reply of at most ${MAX_REPLY_BYTES} bytes` })
    }

    lavish.reply = {
      id: `lavish:${id}:reply`,
      text,
    }
  }

  const known = card.externalSources?.find(source => source.id === id)

  if (after) {
    if (!sequence || !claim || !lavish.reply || after === id) {
      invalidSource({ message: 'Re-arm needs --sequence, --session, --generation and --agent-reply-file with a new source id' })
    }

    const previous = sourceById({
      card,
      id: after,
    })
    const result = previous.results.find(result => result.sequence === sequence)

    if (previous.lavish?.page !== canonicalPage || !result) {
      invalidSource({ message: 'Re-arm must name the exact captured round of this page' })
    }

    if (!lavishCanRearm({ result })) {
      invalidSource({ message: 'This round ends listening; handle it without re-arming' })
    }

    const successor = card.externalSources?.find(source => source.lavish?.after?.source === after
      && source.lavish.after.sequence === sequence && source.id !== id)

    if (successor) {
      invalidSource({ message: `This round already has successor ${successor.id}; read that source` })
    }

    handleResult({
      writer,
      ref,
      id: after,
      sequence,
      claim,
      meta,
      worker,
      validateOnly: true,
    })
    lavish.after = {
      source: after,
      sequence,
    }
  } else if (sequence !== undefined || claim) {
    invalidSource({ message: 'Use --after with the captured round and claim' })
  }

  for (const other of Object.values(writer.state.cards)) {
    for (const source of other.externalSources ?? []) {
      if (source.lavish?.page !== canonicalPage || (other.id === card.id && source.id === id)) {
        continue
      }

      const predecessor = other.id === card.id && source.id === after
      const unresolved = source.state !== 'retired' || source.results.some(result => !result.handled)

      if (!predecessor && unresolved) {
        invalidSource({ message: 'This page already belongs to an unfinished Lavish source' })
      }

      if (!after && !known) {
        invalidSource({ message: 'Continue an existing page with --after; never silently reopen a final round' })
      }
    }
  }

  const registered = registerSource({
    writer,
    ref,
    id,
    command: commandIdentity({
      executable,
      argv: [
        'poll',
        canonicalPage,
      ],
      cwd: dirname(canonicalPage),
    }),
    timeoutMs: SOURCE_MAX_TIMEOUT_MS,
    maxBytes: SOURCE_MAX_BYTES,
    restart: 'never',
    maxRuns: lavish.reply ? REPLY_AND_POLL_RUNS : 1,
    lavish,
    meta,
    worker,
  })

  if (after && sequence && claim) {
    handleResult({
      writer,
      ref,
      id: after,
      sequence,
      claim,
      meta,
      worker,
    })
  }

  return registered
}
