import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { findCard, type Meta } from '../core/decide.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import { EVENT_VERSION, HydraError, type Card, type SteeringClaim } from '../core/model.ts'
import { ownerActor } from '../app/actors.ts'
import type { Writer } from '../app/writer.ts'
import { requireSteeringWorker } from '../task-inbox/inbox.ts'
import { sameClaim, steeringClaim } from '../task-inbox/state.ts'
import type { ExternalSource, ExternalSourceChange, SourceCommand, SourceOutcome, SourceResult } from './model.ts'
import { lavishCanRearm, lavishSession } from './lavish-output.ts'

export const SOURCE_TIMEOUT_MS = 3_600_000
export const SOURCE_MAX_TIMEOUT_MS = 86_400_000
export const SOURCE_MAX_BYTES = 65_536
export const SOURCE_OUTPUT_LIMIT = 1_048_576
export const SOURCE_MAX_RUNS = 10
const MAX_ARGUMENT_BYTES = 65_536

export function invalidSource({
  message,
  code = 'VALIDATION_ERROR',
}: {
  message: string
  code?: string
}): never {
  throw new HydraError({
    message,
    code,
  })
}

export function commandIdentity({
  executable,
  argv,
  cwd,
}: {
  executable: string
  argv: unknown
  cwd: string
}): SourceCommand {
  if (!isAbsolute(executable) || !isAbsolute(cwd) || !Array.isArray(argv)
    || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || Buffer.byteLength(JSON.stringify(argv)) > MAX_ARGUMENT_BYTES) {
    invalidSource({ message: 'Use an absolute executable and cwd, and a bounded JSON string array for argv' })
  }

  try {
    const path = realpathSync(executable)
    accessSync(
      path,
      constants.X_OK,
    )

    if (!statSync(path).isFile() || !statSync(cwd).isDirectory()) {
      invalidSource({ message: 'The executable must be a file and cwd must be a directory' })
    }

    return {
      executable: path,
      digest: createHash('sha256').update(readFileSync(path))
        .digest('hex'),
      argv: argv as string[],
      cwd: realpathSync(cwd),
    }
  } catch (error) {
    invalidSource({ message: `Cannot bind source command: ${(error as Error).message}` })
  }
}

export function sourceTask({
  writer,
  ref,
  meta,
  worker,
}: {
  writer: Pick<Writer, 'state'>
  ref: string
  meta: Meta
  worker?: string
}): Card {
  const card = findCard({
    state: writer.state,
    ref,
  })

  if (card.id === HYDRA_CARD || card.automaticTask || card.mirror
    || card.sourceRefs.some(source => source.adapter === 'firstmate')) {
    invalidSource({ message: 'Choose a native task for external sources' })
  }

  if (meta.actor.startsWith('worker:')) {
    requireSteeringWorker({
      state: writer.state,
      card,
      actor: meta.actor,
      worker,
    })
  } else if (!ownerActor({ actor: meta.actor }) && meta.actor !== 'hydra' && meta.actor !== 'pnyx') {
    invalidSource({
      message: 'Only the owner, Hydra or this task’s worker can manage sources',
      code: 'NOT_ALLOWED',
    })
  }

  return card
}

export function sourceById({
  card,
  id,
}: {
  card: Card
  id: string
}): ExternalSource {
  const source = card.externalSources?.find(source => source.id === id)

  if (!source) {
    invalidSource({ message: 'External source not found on this task' })
  }

  return source
}

export function appendSource({
  writer,
  card,
  meta,
  change,
}: {
  writer: Writer
  card: Card
  meta: Meta
  change: ExternalSourceChange
}): void {
  writer.append({
    event: {
      v: EVENT_VERSION,
      seq: writer.state.seq + 1,
      id: randomUUID(),
      cardId: card.id,
      actor: meta.actor,
      at: meta.at,
      ...change,
    },
  })
}

export function registerSource({
  writer,
  ref,
  id,
  command,
  timeoutMs,
  maxBytes,
  expiresAt,
  restart,
  maxRuns,
  lavish,
  meta,
  worker,
}: {
  writer: Writer
  ref: string
  id: string
  command: SourceCommand
  timeoutMs: number
  maxBytes: number
  expiresAt?: string
  restart: ExternalSource['restart']
  maxRuns: number
  lavish?: ExternalSource['lavish']
  meta: Meta
  worker?: string
}): ExternalSource {
  const card = sourceTask({
    writer,
    ref,
    meta,
    worker,
  })
  const owner = steeringClaim({ card })
  const known = card.externalSources?.find(source => source.id === id)
  const expiry = expiresAt ?? known?.expiresAt
    ?? new Date(Date.parse(meta.at) + SOURCE_MAX_TIMEOUT_MS).toISOString()

  if (!owner || card.hidden) {
    invalidSource({ message: 'An external source needs an assigned worker' })
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    invalidSource({ message: 'Source id must be 1–100 letters, digits, dots, underscores or hyphens' })
  }

  for (const [
    name,
    value,
    limit,
  ] of [
      [
        'timeout',
        timeoutMs,
        SOURCE_MAX_TIMEOUT_MS,
      ],
      [
        'output bytes',
        maxBytes,
        SOURCE_OUTPUT_LIMIT,
      ],
      [
        'runs',
        maxRuns,
        SOURCE_MAX_RUNS,
      ],
    ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
      invalidSource({ message: `${name} must be an integer from 1 to ${limit}` })
    }
  }

  const invalidExpiry = !Number.isFinite(Date.parse(expiry))
  const alreadyExpired = !known && Date.parse(expiry) <= Date.parse(meta.at)

  if (invalidExpiry || alreadyExpired) {
    invalidSource({ message: 'Expiry must be a future ISO timestamp' })
  }

  const registration = randomUUID()
  const source: ExternalSource = {
    id,
    registration,
    owner,
    command,
    timeoutMs,
    maxBytes,
    expiresAt: expiry,
    restart,
    maxRuns,
    runs: 0,
    state: 'registered',
    results: [],
  }

  if (lavish) {
    source.lavish = lavish
  }

  if (known) {
    const configuration = ({ source }: { source: ExternalSource }) => JSON.stringify({
      owner: source.owner,
      command: source.command,
      timeoutMs: source.timeoutMs,
      maxBytes: source.maxBytes,
      expiresAt: source.expiresAt,
      restart: source.restart,
      maxRuns: source.maxRuns,
      lavish: source.lavish && {
        page: source.lavish.page,
        after: source.lavish.after,
        reply: source.lavish.reply && {
          id: source.lavish.reply.id,
          text: source.lavish.reply.text,
        },
      },
    })

    if (configuration({ source: known }) !== configuration({ source })) {
      invalidSource({ message: 'Source id already has a different registration; choose a new id' })
    }

    return known
  }

  appendSource({
    writer,
    card,
    meta,
    change: {
      type: 'task.source.registered',
      data: { source },
    },
  })

  return source
}

export function captureResult({
  writer,
  card,
  source,
  run,
  outcome,
  stdout = '',
  stderr = '',
  detail,
  meta,
}: {
  writer: Writer
  card: Card
  source: ExternalSource
  run: string
  outcome: SourceOutcome
  stdout?: string
  stderr?: string
  detail: string
  meta: Meta
}): void {
  if (source.results.some(result => result.run === run)) {
    return
  }

  if (source.run && source.run.id !== run) {
    invalidSource({
      message: 'Source run no longer owns this registration',
      code: 'STALE_CLAIM',
    })
  }

  const sequence = (source.results.at(-1)?.sequence ?? 0) + 1
  const publication = source.lavish?.reply

  if (publication && !publication.accepted && outcome === 'completed') {
    appendSource({
      writer,
      card,
      meta,
      change: {
        type: 'task.source.lavish.published',
        data: {
          source: source.id,
          reply: publication.id,
          accepted: {
            at: meta.at,
            receipt: stdout,
          },
        },
      },
    })

    return
  }

  const retryable = outcome === 'failed' && source.restart === 'on-failure'
    && source.runs < source.maxRuns && Date.parse(source.expiresAt) > Date.parse(meta.at)
  let terminal = !retryable

  if (source.lavish && outcome === 'completed') {
    const session = lavishSession({ stdout })
    terminal = session.ended || session.status !== 'feedback'
    detail = `Lavish ${session.status}${session.ended ? ' (final round)' : ''}. ${detail}`
  }

  const result: SourceResult = {
    sequence,
    run,
    at: meta.at,
    outcome,
    stdout,
    stderr,
    detail,
    terminal,
    message: `external:${source.registration}:${sequence}`,
  }
  appendSource({
    writer,
    card,
    meta,
    change: {
      type: 'task.source.result',
      data: {
        source: source.id,
        result,
      },
    },
  })
}

export function handleResult({
  writer,
  ref,
  id,
  sequence,
  claim,
  meta,
  worker,
  validateOnly = false,
}: {
  writer: Writer
  ref: string
  id: string
  sequence: number
  claim: SteeringClaim
  meta: Meta
  worker?: string
  validateOnly?: boolean
}): SourceResult {
  const card = sourceTask({
    writer,
    ref,
    meta,
    worker,
  })
  requireSteeringWorker({
    state: writer.state,
    card,
    actor: meta.actor,
    worker,
  })

  if (!sameClaim({
    current: steeringClaim({ card }),
    claim,
  })) {
    invalidSource({
      message: 'Source handling requires the current worker claim',
      code: 'STALE_CLAIM',
    })
  }

  const source = sourceById({
    card,
    id,
  })
  const result = source.results.find(result => result.sequence === sequence)

  if (!result) {
    invalidSource({ message: 'Captured source result not found' })
  }

  if (result.handled) {
    return result
  }

  const message = card.steering?.find(message => message.id === result.message)

  if (!message?.ack) {
    invalidSource({ message: 'Read and acknowledge this result’s steering message before handling it' })
  }

  if (validateOnly) {
    return result
  }

  appendSource({
    writer,
    card,
    meta,
    change: {
      type: 'task.source.handled',
      data: {
        source: id,
        sequence,
        handled: {
          at: meta.at,
          actor: meta.actor,
          claim,
        },
      },
    },
  })

  return sourceById({
    card: writer.state.cards[card.id]!,
    id,
  }).results
    .find(result => result.sequence === sequence)!
}

export function resultText({
  source,
  result,
}: {
  source: ExternalSource
  result: SourceResult
}): string {
  if (source.lavish) {
    const handling = !lavishCanRearm({ result })
      ? 'Conclude this round, acknowledge its inbox message, then mark this source result handled. Do not re-arm or reopen this session.'
      : `Apply every item once. File genuine owner choices with task ask; retain their IDs for the report inventory. Acknowledge inbox message ${result.message}, then re-arm with task source lavish <task> <new-source-id> --page ${JSON.stringify(source.lavish.page)} --executable ${JSON.stringify(source.command.executable)} --after ${source.id} --sequence ${result.sequence} --agent-reply-file <path> --session <session> --generation <generation>. This handles the old round and stages the reply before the next poll.`
    const recovery = result.outcome === 'completed' ? ''
      : ' Listening stopped. Inspect the retained uncertainty and verify prior effects and reply acceptance before any explicit recovery; never blindly repeat a post or destructive poll.'

    return `Lavish source ${source.id}, round ${result.sequence}: ${result.outcome}. ${result.detail}\n`
      + `Captured output (read completely):\n${result.stdout}\nstderr:\n${result.stderr}\n`
      + `Read with task source read <task> ${source.id}. ${handling}${recovery}`
  }

  return `External source ${source.id}, result ${result.sequence}: ${result.outcome}. ${result.detail}\n`
    + `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`
    + `Read with task source read <task> ${source.id}; acknowledge inbox message ${result.message}, then task source handled <task> ${source.id} ${result.sequence} --session <session> --generation <generation>.`
}
