import { transcriptMessages } from '#workers/transcripts.ts'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import type { HydraEvent } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readReport } from '#investigations/report.ts'
import { decidePush } from '#tasks/push.ts'
import { searchPath, sqlite, updateIndex } from './index.ts'
import { search } from './search.ts'
import { redact } from './text.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-test-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

const TRANSCRIPT = join(
  import.meta.dirname,
  '..',
  'hydra',
  'fixtures',
  'transcripts',
  'claude-session.jsonl',
)
const CODEX = join(
  import.meta.dirname,
  '..',
  'hydra',
  'fixtures',
  'transcripts',
  'codex-session.jsonl',
)

test(
  'Oracle recovers task instructions, reports and helper results after edits and an index rebuild',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      scratch,
      'pnyx-oracle-records-',
    ))
    const write = ({ events }: { events: HydraEvent[] }) => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        for (const event of events) {
          writer.append({
            event: {
              ...event,
              seq: writer.state.seq + 1,
            },
            effects: false,
          })
        }

        return writer.state
      },
    })
    const base = {
      v: 1 as const,
      seq: 0,
      actor: 'fixture',
      cardId: 'task-records',
      at: '2026-10-15T10:00:00Z',
    }
    write({
      events: [
        {
          ...base,
          id: 'created-records',
          type: 'task.created',
          data: {
            key: 'records',
            title: 'Recorded instructions',
            kind: 'investigation',
            intent: 'Retain saffron instructions.',
            brief: 'Confirm semaphore behavior.',
            ask: {
              text: 'Record marzipan preferences.',
              at: base.at,
              actor: 'cli',
            },
          },
        },
        {
          ...base,
          cardId: 'task-other',
          id: 'created-other',
          type: 'task.created',
          data: {
            key: 'other',
            title: 'Another task',
          },
        },
      ],
    })
    updateIndex({ hydraId: 'default' })
    const find = ({ text }: { text: string }) => search({
      hydraId: 'default',
      query: {
        text,
        limit: 20,
        highlight: false,
      },
    }).hits
    assert.deepEqual(
      find({ text: 'saffron semaphore marzipan' }).map(hit => hit.card),
      ['task-records'],
    )

    const reportText = '# Findings\n\nMossstone validation found a ledger mismatch. sk-abcdefghijklmnop1234'
    const stored = write({
      events: [
        {
          ...base,
          id: 'stored-report',
          type: 'task.report',
          data: { text: reportText },
        },
      ],
    })
    assert.equal(
      readReport({
        hydraId: 'default',
        card: stored.cards[base.cardId],
      }),
      reportText,
    )
    updateIndex({ hydraId: 'default' })
    assert.deepEqual(
      find({ text: 'mossstone' }).map(hit => hit.card),
      ['task-records'],
    )
    assert.match(
      find({ text: 'mossstone' })[0]?.snippets[0]?.snippet ?? '',
      /\[redacted\]/,
    )

    const revisedReport = '# Findings\n\nTourmaline validation confirms the cause.'
    const revised = write({
      events: [
        {
          ...base,
          id: 'revised-report',
          type: 'task.report',
          data: { text: revisedReport },
        },
        {
          ...base,
          id: 'revised-records',
          type: 'task.brief',
          data: {
            before: 'Confirm semaphore behavior.',
            after: 'Validate cobalt pipeline. sk-abcdefghijklmnop1234',
            intent: 'Publish indigo output.',
          },
        },
        {
          ...base,
          id: 'later-records',
          type: 'task.owner-ask',
          data: {
            text: 'Keep tangerine summaries.',
            at: base.at,
            actor: 'cli',
          },
        },
        {
          ...base,
          id: 'legacy-records',
          type: 'task.intent',
          data: {
            text: 'Review vermilion logs.',
            at: base.at,
            actor: 'cli',
          },
        },
        {
          ...base,
          cardId: HYDRA_CARD,
          id: 'helper-finished:records',
          type: 'hydra.helper-finished',
          data: {
            batch: 'records',
            outcomes: [
              {
                task: base.cardId,
                audience: 'routine',
                summary: 'Topaz export succeeded.',
              },
              {
                task: 'task-other',
                audience: 'owner',
                summary: 'Amber format needs approval. sk-abcdefghijklmnop1234',
              },
            ],
          },
        },
        {
          ...base,
          cardId: HYDRA_CARD,
          id: 'helper-finished:decision',
          type: 'hydra.helper-finished',
          data: {
            batch: 'decision',
            outcomes: [
              {
                task: base.cardId,
                status: 'needs_main',
                summary: 'Quartz approval needs a decision.',
              },
            ],
          },
        },
        {
          ...base,
          cardId: HYDRA_CARD,
          id: 'helper-finished:wait',
          type: 'hydra.helper-finished',
          data: {
            batch: 'wait',
            outcomes: [
              {
                task: base.cardId,
                status: 'still_waiting',
                summary: 'Obsidian wait is unchanged.',
              },
            ],
          },
        },
        {
          ...base,
          cardId: HYDRA_CARD,
          id: 'helper-finished:checks',
          type: 'hydra.helper-finished',
          data: {
            batch: 'checks',
            outcomes: [
              {
                task: base.cardId,
                status: 'handled',
                summary: 'Jasper checks passed.',
              },
            ],
          },
        },
        {
          ...base,
          id: 'helper-result:records:task-records',
          actor: 'pnyx',
          type: 'hydra.message',
          data: {
            hydra: 'hydra',
            action: 'send',
            kind: 'routine',
            task: base.cardId,
            text: 'Jasper checks passed.',
          },
        },
      ],
    })
    assert.equal(
      readReport({
        hydraId: 'default',
        card: revised.cards[base.cardId],
      }),
      revisedReport,
    )
    updateIndex({ hydraId: 'default' })
    assert.deepEqual(
      find({ text: 'mossstone tourmaline' }).map(hit => hit.card),
      ['task-records'],
    )
    assert.deepEqual(
      find({ text: 'cobalt indigo tangerine vermilion' }).map(hit => hit.card),
      ['task-records'],
    )
    assert.deepEqual(
      find({ text: 'semaphore' }).map(hit => hit.card),
      ['task-records'],
    )
    assert.deepEqual(
      find({ text: 'topaz quartz' }).map(hit => hit.card),
      ['task-records'],
    )
    assert.deepEqual(
      find({ text: 'amber' }).map(hit => hit.card),
      ['task-other'],
    )
    assert.match(
      find({ text: 'amber' })[0]?.snippets[0]?.snippet ?? '',
      /\[redacted\]/,
    )
    assert.deepEqual(
      find({ text: 'obsidian' }),
      [],
    )
    assert.equal(
      find({ text: 'jasper' })[0]?.snippets.length,
      1,
    )
    assert.match(
      find({ text: 'cobalt' })[0]?.snippets[0]?.snippet ?? '',
      /\[redacted\]/,
    )

    const { DatabaseSync } = sqlite()
    const oldIndex = new DatabaseSync(searchPath({ hydraId: 'default' }))
    // Version 7 omitted report bodies while still advancing its event cursor.
    oldIndex.exec(`
      UPDATE meta SET value = '7' WHERE key = 'chunker_version';
      DELETE FROM docs;
      DELETE FROM card_fts;
    `)
    oldIndex.close()
    updateIndex({ hydraId: 'default' })
    assert.deepEqual(
      find({ text: 'saffron semaphore marzipan cobalt indigo tangerine vermilion topaz quartz jasper' })
        .map(hit => hit.card),
      ['task-records'],
    )
    assert.deepEqual(
      find({ text: 'obsidian' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'mossstone tourmaline' }).map(hit => hit.card),
      ['task-records'],
    )
    assert.match(
      find({ text: 'mossstone' })[0]?.snippets[0]?.snippet ?? '',
      /\[redacted\]/,
    )
  },
)

test(
  'secret-shaped strings are redacted',
  () => {
    const text = [
      'sk-abcdefghijklmnop1234',
      'ghp_abcdefghijklmnopqrstuvwxyz',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
      '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    ].join(' ')
    assert.equal(
      redact({ text }),
      Array(6).fill('[redacted]')
        .join(' '),
    )
    assert.equal(
      redact({ text: 'skip the sk- prefix' }),
      'skip the sk- prefix',
    )
  },
)

test(
  'only typed messages and assistant text are read from Claude Code and Codex transcripts',
  () => {
    const messages = ({ path }: { path: string }) => readFileSync(
      path,
      'utf8',
    ).split('\n')
      .slice(
        0,
        -1,
      )
      .flatMap(l => transcriptMessages({ record: JSON.parse(l) as unknown }))
    const texts = messages({ path: TRANSCRIPT }).map(m => m.text)
    assert.deepEqual(
      texts.slice(
        0,
        2,
      ),
      [
        'Why did the deploy get reverted after the migration?',
        'The migration locked the orders table, so the deploy was rolled back.',
      ],
    )
    const all = texts.join('\n')

    for (const hidden of [
      'toolinputword',
      'tooloutputword',
      'secretthought',
      'metaskillbody',
      'injectedreminder',
      'summaryrecordword',
    ]) {
      assert.ok(
        !all.includes(hidden),
        hidden,
      )
    }

    assert.match(
      all,
      /Use the token sk-/,
    )
    assert.deepEqual(
      messages({ path: CODEX }),
      [
        {
          at: '2026-10-12T10:00:03.000Z',
          text: 'Why is the invoice export timing out?',
        },
        {
          at: '2026-10-12T10:00:07.000Z',
          text: 'The export query scans every invoice without an index.',
        },
      ],
    )
  },
)

test(
  'unhighlighted snippets preserve Markdown URLs, brackets and line breaks',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      scratch,
      'pnyx-oracle-markdown-',
    ))
    const text = '[PR](https://github.com/example/project/pull/42)\n\n- **Ready** [literal].'
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: 1,
          id: 'markdown',
          at: '2026-10-15T10:00:00Z',
          actor: 'fixture',
          cardId: '$board',
          type: 'hydra.message',
          data: {
            action: 'send',
            text,
            hydra: 'hydra',
          },
        },
      }),
    })
    updateIndex({ hydraId: 'default' })

    for (const query of [
      'project',
      'github',
    ]) {
      assert.equal(
        search({
          hydraId: 'default',
          query: {
            text: query,
            limit: 1,
            highlight: false,
          },
        }).hits[0]?.snippets[0]?.snippet,
        text,
      )
    }

    assert.match(
      search({
        hydraId: 'default',
        query: {
          text: 'project',
          limit: 1,
        },
      }).hits[0]!.snippets[0]!.snippet,
      /example\/\[project\]\/pull/,
    )
  },
)

test(
  'a search answers from the saved index while a catch-up holds its write lock',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      scratch,
      'pnyx-oracle-locked-',
    ))
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: 1,
          id: 'keys',
          at: '2026-10-15T10:00:00Z',
          actor: 'fixture',
          cardId: '$board',
          type: 'hydra.message',
          data: {
            action: 'send',
            text: 'Rotate the signing keys',
            hydra: 'hydra',
          },
        },
      }),
    })
    updateIndex({ hydraId: 'default' })
    const { DatabaseSync } = sqlite()
    const catchUp = new DatabaseSync(searchPath({ hydraId: 'default' }))
    // A long catch-up holds the lock this strongly once its page cache spills.
    catchUp.exec('BEGIN EXCLUSIVE; DELETE FROM docs;')

    try {
      assert.deepEqual(
        search({
          hydraId: 'default',
          query: {
            text: 'signing',
            limit: 1,
          },
        }).hits.map(hit => hit.card),
        ['$board'],
      )
    } finally {
      catchUp.exec('ROLLBACK')
      catchUp.close()
    }
  },
)

test(
  'building the search index writes nothing to the Hydra, so the server stays its only writer',
  () => {
    const home = mkdtempSync(join(
      scratch,
      'pnyx-oracle-reader-',
    ))
    process.env.PNYX_HOME = home
    // Hydra's own session has a transcript whose messages a harvest would record as events.
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          key: HYDRA_CARD,
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'reader-session',
              transcriptPath: TRANSCRIPT,
            },
          },
          meta: {
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
          },
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
      },
    })
    const dir = join(
      home,
      'hydras',
      'default',
    )
    const log = readFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      'utf8',
    )

    updateIndex({ hydraId: 'default' })

    assert.equal(
      readFileSync(
        join(
          dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
    assert.equal(
      existsSync(join(
        dir,
        'harvest.json',
      )),
      false,
    )
  },
)

test(
  'Oracle omits context notes from native transcripts and previously harvested messages after rebuilding',
  () => {
    const home = mkdtempSync(join(
      scratch,
      'pnyx-oracle-context-',
    ))
    process.env.PNYX_HOME = home
    const transcriptPath = join(
      home,
      'context.jsonl',
    )
    cpSync(
      new URL(
        '../hydra/fixtures/transcripts/lookup-session.jsonl',
        import.meta.url,
      ),
      transcriptPath,
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          key: HYDRA_CARD,
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'context-session',
              transcriptPath,
            },
          },
          meta: {
            at: '2026-01-01T00:00:00.000Z',
            actor: 'fixture',
          },
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'legacy-context',
            at: '2026-01-01T00:00:00.000Z',
            actor: 'fixture',
            cardId: HYDRA_CARD,
            type: 'chat.message',
            data: {
              session: 'older-session',
              nativeId: '0:m0',
              role: 'user',
              text: '<pnyx-context>harvestedcontextword</pnyx-context>\nRetain the archive.',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'legacy-context-wake',
            at: '2026-01-01T00:00:01.000Z',
            actor: 'fixture',
            cardId: HYDRA_CARD,
            type: 'chat.message',
            data: {
              session: 'older-session',
              nativeId: '1:m0',
              role: 'user',
              text: '<pnyx-context>Routine context</pnyx-context>\n<pnyx-wake>Check work</pnyx-wake>\narchivedwakeword',
            },
          },
        })
      },
    })
    const find = ({ text }: { text: string }) => search({
      hydraId: 'default',
      query: {
        text,
        limit: 20,
        highlight: false,
      },
    }).hits
    updateIndex({ hydraId: 'default' })
    assert.equal(
      find({ text: 'sample' }).length,
      1,
    )
    assert.equal(
      find({ text: 'archive' }).length,
      1,
    )
    assert.deepEqual(
      find({ text: 'contextprefixedword' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'contextonlyword' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'harvestedcontextword' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'archivedwakeword' }),
      [],
    )
    const { DatabaseSync } = sqlite()
    const oldIndex = new DatabaseSync(searchPath({ hydraId: 'default' }))
    oldIndex.exec("UPDATE meta SET value = '8' WHERE key = 'chunker_version'; DELETE FROM docs; DELETE FROM card_fts;")
    oldIndex.close()
    updateIndex({ hydraId: 'default' })
    assert.equal(
      find({ text: 'sample' }).length,
      1,
    )
    assert.equal(
      find({ text: 'archive' }).length,
      1,
    )
    assert.deepEqual(
      find({ text: 'contextprefixedword' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'contextonlyword' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'harvestedcontextword' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'archivedwakeword' }),
      [],
    )
  },
)
