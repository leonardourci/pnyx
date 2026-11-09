import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readLog } from '#app/event-log.ts'
import { replayOwned } from '#app/reducer.ts'
import { withWriter } from '#app/writer.ts'
import { writeSnapshot } from '#app/snapshot.ts'
import { harvestTranscripts, backfillConversations } from '#integrations/hooks/harvest.ts'
import { checkConversation } from '#hydra/conversation-check.ts'
import { hydraMessages } from '#hydra/chat-messages.ts'
import { joinMessageParts } from '#hydra/history.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { messageReference } from '#hydra/message-reference.ts'
import { mergeThreadPages } from '#hydra/thread-history.ts'
import { hydraThreadView } from '#hydra/thread-view.ts'
import { readThread, recordEntries, type ThreadEntry } from '#hydra/transcripts-read.ts'
import type { HydraState } from '#app/model.ts'

const PAGE_LIMIT = 1000
const BACKFILL_BATCH_LIMIT = 100_000
const HASH_LENGTH = 12
const EXAMPLE_LIMIT = 10
const hash = ({ value }: { value: string }) => createHash('sha256').update(value)
  .digest('hex')
  .slice(
    0,
    HASH_LENGTH,
  )

function transcriptBytes({
  path,
  through,
}: {
  path: string
  through: number
}) {
  const fd = openSync(
    path,
    'r',
  )

  try {
    const bytes = Buffer.alloc(through)
    let offset = 0

    while (offset < bytes.length) {
      const count = readSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )

      if (count === 0) {
        throw new Error('A native transcript is shorter than its archived cursor.')
      }

      offset += count
    }

    return bytes
  } finally {
    closeSync(fd)
  }
}

export function replayChat({
  archive,
  roots,
}: {
  archive: string
  roots: string[]
}) {
  const scratch = mkdtempSync(join(
    tmpdir(),
    'pnyx-chat-replay-',
  ))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = scratch

  try {
    const settings = join(
      scratch,
      'settings',
    )
    mkdirSync(settings)
    writeFileSync(
      join(
        settings,
        'events.jsonl',
      ),
      `${JSON.stringify({
        v: 1,
        id: 'replay',
        after: { focusMode: false },
      })}\n`,
    )

    return readdirSync(join(
      archive,
      'hydras',
    )).map(hydra => {
      const source = join(
        archive,
        'hydras',
        hydra,
      )
      const target = join(
        scratch,
        'hydras',
        hydra,
      )
      mkdirSync(
        target,
        { recursive: true },
      )
      const bytes = readFileSync(join(
        source,
        'events.jsonl',
      ))
      const events = readLog({ dir: source })!.events
      const snapshot = JSON.parse(readFileSync(
        join(
          source,
          'snapshot.json',
        ),
        'utf8',
      )) as {
        state: HydraState
        offset: number
      }
      const state = replayOwned({
        state: snapshot.state,
        events: events.filter(event => event.seq > snapshot.state.seq),
      })
      const cursors = JSON.parse(readFileSync(
        join(
          source,
          'harvest.json',
        ),
        'utf8',
      )) as Record<string, {
        identity: string
        pos: number
        conversation?: number
      }>
      const copied: typeof cursors = {}
      const admitted = new Map<string, string>()
      const expectedNative: ThreadEntry[] = []
      const inventory: {
        session: string
        bytes: number
      }[] = []

      for (const [
        key,
        cursor,
      ] of Object.entries(cursors)) {
        if (!key.startsWith(`${HYDRA_CARD}\n`)) {
          continue
        }

        const path = key.slice(HYDRA_CARD.length + 1)
        const approved = roots.some(root => {
          const part = relative(
            realpathSync(root),
            realpathSync(path),
          )

          return part !== '..' && !part.startsWith('../') && !isAbsolute(part)
        })
        const sessions = Object.values(state.sessions ?? {})
        const session = sessions.find(session => session.agent.transcriptPath === path)

        if (!approved || !session) {
          throw new Error('A Hydra transcript is outside the selected roots or has no recorded session.')
        }

        if (!Number.isSafeInteger(cursor.pos) || cursor.pos < 0) {
          throw new Error('An archived transcript cursor has an invalid byte position.')
        }

        const native = transcriptBytes({
          path,
          through: cursor.pos,
        })
        const destination = join(
          target,
          `${hash({ value: session.id })}.jsonl`,
        )
        writeFileSync(
          destination,
          native,
        )
        const info = statSync(destination)
        copied[`${HYDRA_CARD}\n${destination}`] = {
          ...cursor,
          identity: `${info.dev}:${info.ino}`,
        }
        admitted.set(
          path,
          destination,
        )

        inventory.push({
          session: hash({ value: session.id }),
          bytes: native.length,
        })
        let offset = 0

        for (const line of native.toString('utf8').split('\n')
          .slice(
            0,
            -1,
          )) {
          const entries = recordEntries({
            record: JSON.parse(line),
            offset,
            boundaries: true,
          })

          for (const entry of entries) {
            expectedNative.push({
              ...entry,
              session: session.id,
              reference: messageReference({
                session: session.id,
                id: entry.id,
                messageId: entry.messageId,
              }),
            })
          }

          offset += Buffer.byteLength(line) + 1
        }
      }

      const currentPath = state.cards[HYDRA_CARD]?.agent?.transcriptPath

      if (currentPath && !admitted.has(currentPath)) {
        throw new Error('The current Hydra transcript has no admitted archived cursor.')
      }

      for (const session of Object.values(state.sessions ?? {})) {
        session.agent.transcriptPath = admitted.get(session.agent.transcriptPath ?? '')
      }

      for (const card of Object.values(state.cards)) {
        if (card.agent) {
          card.agent.transcriptPath = admitted.get(card.agent.transcriptPath ?? '')
        }
      }

      writeFileSync(
        join(
          target,
          'events.jsonl',
        ),
        bytes,
      )
      writeSnapshot({
        dir: target,
        offset: bytes.length,
        state,
      })
      writeFileSync(
        join(
          target,
          'harvest.json',
        ),
        JSON.stringify(copied),
      )

      let complete = false

      for (let batch = 0; batch < BACKFILL_BATCH_LIMIT; batch++) {
        const result = withWriter({
          hydraId: hydra,
          fn: ({ writer }) => backfillConversations({
            writer,
            at: events.at(-1)!.at,
          }),
        })

        if (!result.progressed) {
          complete = true
          break
        }
      }

      if (!complete) {
        throw new Error('Conversation backfill did not finish within the replay limit.')
      }

      const repaired = withWriter({
        hydraId: hydra,
        fn: ({ writer }) => {
          harvestTranscripts({
            writer,
            cardIds: [HYDRA_CARD],
            at: events.at(-1)!.at,
          })

          return writer.state
        },
      })
      const card = repaired.cards[HYDRA_CARD]

      if (!card) {
        throw new Error('The archived Hydra has no chat card.')
      }

      let page = readThread({
        hydraId: hydra,
        state: repaired,
        card,
        homes: [],
      })
      const seen = new Set<string>()
      let pages = 1

      while (page.older) {
        if (seen.has(page.older) || pages >= PAGE_LIMIT) {
          throw new Error('Conversation history did not finish paging.')
        }

        seen.add(page.older)
        const older = readThread({
          hydraId: hydra,
          state: repaired,
          card,
          homes: [],
          before: page.older,
        })
        page = mergeThreadPages({
          before: page,
          latest: older,
          olderPage: true,
        })
        pages++
      }

      const expected = hydraMessages({
        messages: repaired.hydraMessages ?? [],
        transcript: joinMessageParts({ entries: expectedNative }),
        provider: card.agent?.provider,
        boundaries: true,
      })
        .filter(entry => (!entry.hidden || entry.role === 'Pnyx') && entry.text.trim() !== 'NO_REPLY')
        .sort((
          a,
          b,
        ) => (a.at ?? '').localeCompare(b.at ?? ''))
      const conversation = hydraThreadView({
        state: repaired,
        page,
        tools: true,
        thinking: true,
      }).conversation
      const ordered = expected.filter(entry => entry.at !== undefined)
      const mismatches = checkConversation({
        expected,
        conversation,
        ordered,
      })
      const counts = {
        missing: 0,
        duplicate: 0,
        order: 0,
        text: 0,
        tool: 0,
        progress: 0,
        hidden: 0,
        unexpected: 0,
      }

      for (const mismatch of mismatches) {
        counts[mismatch.kind]++
      }

      return {
        hydra: hash({ value: hydra }),
        inventory,
        pages,
        expected: expected.length,
        undated: expected.length - ordered.length,
        counts,
        examples: mismatches.slice(
          0,
          EXAMPLE_LIMIT,
        ).map(mismatch => ({
          kind: mismatch.kind,
          reference: hash({ value: mismatch.reference }),
        })),
      }
    })
  } finally {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(
      scratch,
      {
        recursive: true,
        force: true,
      },
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      'claude-transcripts': {
        type: 'string',
        default: join(
          homedir(),
          '.claude/projects',
        ),
      },
      'codex-transcripts': {
        type: 'string',
        default: join(
          homedir(),
          '.codex/sessions',
        ),
      },
    },
  })

  if (!values.archive) {
    throw new Error('Use --archive <evidence-copy>; only archived Hydra sessions are read.')
  }

  const result = replayChat({
    archive: values.archive,
    roots: [
      values['claude-transcripts'],
      values['codex-transcripts'],
    ],
  })
  process.stdout.write(`${JSON.stringify(
    result,
    null,
    2,
  )}\n`)
  const failed = result.some(hydra => Object.values(hydra.counts).some(count => count > 0))
  process.exitCode = failed ? 1 : 0
}
