import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { readTranscriptRecord } from '#workers/transcripts.ts'
import type { AgentRef } from '#workers/model.ts'

async function lastDigest({ agent }: { agent?: AgentRef }): Promise<{
  digest?: string
  compacted: boolean
}> {
  if (!agent?.transcriptPath) {
    return { compacted: false }
  }

  let compacted = false
  let digest: string | undefined
  const stream = createReadStream(
    agent.transcriptPath,
    { encoding: 'utf8' },
  )
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      let record: unknown

      try {
        record = JSON.parse(line)
      } catch (error) {
        if (error instanceof SyntaxError) {
          continue
        }

        throw error
      }

      const parsed = readTranscriptRecord({ record })

      if (parsed.contextReset) {
        digest = undefined
        compacted = true
      }

      if (parsed.digest) {
        digest = parsed.digest
        compacted = false
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  return {
    digest,
    compacted,
  }
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
