import { open } from 'node:fs/promises'
import { readTranscriptRecord } from '#workers/transcripts.ts'
import type { AgentRef } from '#workers/model.ts'

const DIGEST_READ_BYTES = 64 * 1024

function digestRecord({ line }: { line: string }): {
  digest?: string
  compacted: boolean
} | undefined {
  let record: unknown

  try {
    record = JSON.parse(line)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }

    throw error
  }

  const parsed = readTranscriptRecord({ record })

  if (parsed.digest) {
    return {
      digest: parsed.digest,
      compacted: false,
    }
  }

  if (parsed.contextReset) {
    return { compacted: true }
  }

  return undefined
}

async function lastDigest({ agent }: { agent?: AgentRef }): Promise<{
  digest?: string
  compacted: boolean
}> {
  if (!agent?.transcriptPath) {
    return { compacted: false }
  }

  let file: Awaited<ReturnType<typeof open>> | undefined

  try {
    file = await open(
      agent.transcriptPath,
      'r',
    )
    let position = (await file.stat()).size
    // The start of the line that continues into the block read last, in file order; each byte is scanned once.
    let partial: Buffer[] = []

    while (position > 0) {
      const size = Math.min(
        position,
        DIGEST_READ_BYTES,
      )
      position -= size
      const block = Buffer.alloc(size)
      await file.read(
        block,
        0,
        size,
        position,
      )
      let end = block.length

      for (let index = block.length - 1; index >= 0; index--) {
        if (block[index] !== 10) {
          continue
        }

        const recovered = digestRecord({
          line: Buffer.concat([
            block.subarray(
              index + 1,
              end,
            ),
            ...partial,
          ]).toString('utf8'),
        })
        partial = []

        if (recovered) {
          return recovered
        }

        end = index
      }

      partial.unshift(block.subarray(
        0,
        end,
      ))
    }

    return digestRecord({ line: Buffer.concat(partial).toString('utf8') }) ?? { compacted: false }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  } finally {
    await file?.close()
  }

  return { compacted: false }
}

export function createDigestContext({
  agent,
  render,
}: {
  agent?: AgentRef
  render({
    previousDigest,
    compacted,
  }: {
    previousDigest?: string
    compacted: boolean
  }): Promise<string>
}) {
  let loaded = false
  let previousDigest: string | undefined

  return async ({ compacted = false }: { compacted?: boolean } = {}): Promise<string> => {
    if (!loaded && !compacted) {
      const recovered = await lastDigest({ agent })
      previousDigest = recovered.digest
      compacted = recovered.compacted
    }

    loaded = true

    if (compacted) {
      previousDigest = undefined
    }

    const text = await render({
      previousDigest,
      compacted,
    })
    previousDigest = text

    return text
  }
}
