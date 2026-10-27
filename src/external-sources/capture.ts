import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { hydraDir } from '../app/home-migration.ts'
import { withWriter } from '../app/writer.ts'
import { privateDir } from '../store/hydra-store.ts'
import type { ChildResult } from './child.ts'
import { captureResult } from './sources.ts'

export interface BufferedCapture {
  card: string
  source: string
  registration: string
  run: string
  at: string
  result: ChildResult
}

const captureDirectory = ({ hydraId }: { hydraId: string }) =>
  join(
    hydraDir({ hydraId }),
    'source-captures',
  )

export function bufferCapture({
  hydraId,
  capture,
}: {
  hydraId: string
  capture: BufferedCapture
}): string {
  const directory = captureDirectory({ hydraId })
  privateDir({ dir: directory })
  const name = createHash('sha256').update(capture.registration)
    .update(capture.run)
    .digest('hex')
  const path = join(
    directory,
    `${name}.json`,
  )

  if (existsSync(path)) {
    return path
  }

  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(
    temporary,
    'wx',
    0o600,
  )

  try {
    writeFileSync(
      descriptor,
      JSON.stringify(capture),
    )
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }

  renameSync(
    temporary,
    path,
  )

  return path
}

export function bufferedCaptures({ hydraId }: { hydraId: string }): {
  path: string
  capture: BufferedCapture
}[] {
  const directory = captureDirectory({ hydraId })

  if (!existsSync(directory)) {
    return []
  }

  return readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => {
      const path = join(
        directory,
        name,
      )

      return {
        path,
        capture: JSON.parse(readFileSync(
          path,
          'utf8',
        )) as BufferedCapture,
      }
    })
}

export function commitCapture({
  hydraId,
  path,
  capture,
}: {
  hydraId: string
  path: string
  capture: BufferedCapture
}): void {
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const card = writer.state.cards[capture.card]
      const source = card?.externalSources?.find(source => source.id === capture.source
      && source.registration === capture.registration)

      if (!card || !source || source.results.some(result => result.run === capture.run)) {
        return
      }

      if (source.run?.id !== capture.run) {
        return
      }

      captureResult({
        writer,
        card,
        source,
        run: capture.run,
        outcome: capture.result.outcome,
        stdout: capture.result.stdout,
        stderr: capture.result.stderr,
        detail: capture.result.detail,
        meta: {
          actor: 'pnyx',
          at: capture.at,
        },
      })
    },
  })
  rmSync(
    path,
    { force: true },
  )
}
