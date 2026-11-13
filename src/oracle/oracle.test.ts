import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { transcriptMessages } from '#workers/transcripts.ts'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import type { HydraEvent } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readReport } from '#investigations/report.ts'
import { decidePush } from '#tasks/push.ts'
import { storedHydra } from '#test-harness/database.ts'
import { search } from './search.ts'
import { searchInBackground } from './search-background.ts'
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

const MENTIONS = 20
const LONG_HISTORY = 130_000
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
  'Oracle recovers task instructions, reports and helper results after edits',
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
            brief: 'Confirm semaphore migração deploying behavior.',
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
            before: 'Confirm semaphore migração deploying behavior.',
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
    assert.equal(
      find({ text: 'saffr*' })[0]?.card,
      'task-records',
    )
    assert.equal(
      find({ text: 'saffrn' })[0]?.match,
      'fuzzy',
    )
    assert.equal(
      find({ text: 'migracao' })[0]?.card,
      'task-records',
    )
    assert.equal(
      find({ text: 'deploy' })[0]?.card,
      'task-records',
    )
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
          block: 0,
        },
        {
          at: '2026-10-12T10:00:07.000Z',
          text: 'The export query scans every invoice without an index.',
          block: 0,
        },
      ],
    )
  },
)

test(
  'Oracle snippets preserve Markdown and center highlighted path matches',
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

    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'late-path',
          at: '2026-10-15T10:00:01Z',
          actor: 'fixture',
          cardId: '$board',
          type: 'hydra.message',
          data: {
            action: 'send',
            text: `${'preface '.repeat(40)}src/oracle/needle.ts ${'context '.repeat(40)}re\u0301paration`,
            hydra: 'hydra',
          },
        },
      }),
    })
    const path = search({
      hydraId: 'default',
      query: {
        text: 'src/oracle/needle.ts',
        limit: 1,
        highlight: true,
      },
    }).hits[0]!.snippets[0]!
    assert.match(
      path.snippet,
      /\[src\]\/\[oracle\]\/\[needle\]\.\[ts\]/,
    )
    assert.deepEqual(
      path.parts?.filter(part => part.matched).map(part => part.text),
      [
        'src',
        'oracle',
        'needle',
        'ts',
      ],
    )
    const accent = search({
      hydraId: 'default',
      query: {
        text: 'reparation',
        limit: 1,
        highlight: true,
      },
    }).hits[0]!.snippets[0]!
    assert.ok(accent.snippet.includes('[re\u0301paration]'))
    assert.deepEqual(
      accent.parts?.filter(part => part.matched).map(part => part.text),
      ['re\u0301paration'],
    )
  },
)

test(
  'searches leave sources untouched, deduplicate archives and follow moved sessions',
  async () => {
    const home = mkdtempSync(join(
      scratch,
      'pnyx-oracle-reader-',
    ))
    process.env.PNYX_HOME = home
    const transcriptPath = join(
      home,
      'reader.jsonl',
    )
    cpSync(
      TRANSCRIPT,
      transcriptPath,
    )
    const card = withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'reader-created',
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
            cardId: 'reader',
            type: 'task.created',
            data: {
              key: 'reader',
              title: 'Saved conversation',
            },
          },
        })
        const pushed = decidePush({
          state: writer.state,
          key: 'reader',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'reader-session',
              transcriptPath,
            },
          },
          meta: {
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
          },
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
        harvestTranscripts({
          writer,
          cardIds: [pushed.event.cardId],
          at: '2026-10-15T10:00:00Z',
        })

        return pushed.event.cardId
      },
    })
    const dir = join(
      home,
      'hydras',
      'default',
    )
    const stored = storedHydra({ hydraId: 'default' })
    const cursors = readFileSync(
      join(
        dir,
        'harvest.json',
      ),
      'utf8',
    )
    const result = await searchInBackground({
      hydraId: 'default',
      query: {
        text: 'migration',
        limit: 20,
      },
    })

    assert.equal(
      result.hits[0]?.card,
      card,
    )
    assert.equal(
      result.hits[0]?.snippets.length,
      2,
      'native lines already archived appear only once',
    )
    await assert.rejects(
      searchInBackground({
        hydraId: 'default',
        query: {
          text: '!!!',
          limit: 20,
        },
      }),
      { code: 'VALIDATION_ERROR' },
    )
    assert.equal(
      existsSync(join(
        dir,
        'search.db',
      )),
      false,
    )

    assert.equal(
      storedHydra({ hydraId: 'default' }),
      stored,
    )
    assert.equal(
      readFileSync(
        join(
          dir,
          'harvest.json',
        ),
        'utf8',
      ),
      cursors,
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'receiver-created',
            cardId: 'receiver',
            at: '2026-10-15T10:01:00Z',
            actor: 'fixture',
            type: 'task.created',
            data: {
              key: 'receiver',
              title: 'Moved conversation',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'reader-moved',
            cardId: 'receiver',
            at: '2026-10-15T10:01:00Z',
            actor: 'fixture',
            type: 'task.session',
            data: {
              session: 'claude-code:reader-session',
              before: card,
              after: 'receiver',
            },
          },
        })
      },
    })
    appendFileSync(
      transcriptPath,
      `\n${JSON.stringify({
        type: 'user',
        timestamp: '2026-10-15T10:02:00Z',
        message: {
          role: 'user',
          content: 'unarchived relocationneedle',
        },
      })}\n`,
    )
    assert.deepEqual(
      search({
        hydraId: 'default',
        query: {
          text: 'relocationneedle',
          limit: 20,
        },
      }).hits.map(hit => hit.card),
      ['receiver'],
    )
    assert.deepEqual(
      search({
        hydraId: 'default',
        query: {
          text: 'relocationneedle',
          card,
          limit: 20,
        },
      }).hits,
      [],
    )
    assert.equal(
      search({
        hydraId: 'default',
        query: {
          text: 'migration',
          card,
          limit: 20,
        },
      }).hits[0]?.snippets.length,
      2,
      'archived conversation remains on its recorded task after the move',
    )
  },
)

test(
  'Oracle omits context notes from native transcripts and previously harvested messages',
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
    writeFileSync(
      transcriptPath,
      `${`invalid-json${'x'.repeat(16_000)}\n`.repeat(20)}${readFileSync(
        transcriptPath,
        'utf8',
      )}`,
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
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'archived-tool',
            at: '2026-01-01T00:00:02Z',
            actor: 'fixture',
            cardId: HYDRA_CARD,
            type: 'chat.message',
            data: {
              session: 'older-session',
              nativeId: 'archived-tool',
              role: 'assistant',
              kind: 'tool',
              hidden: false,
              text: 'foxtrotspool',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'archived-thinking',
            at: '2026-01-01T00:00:02Z',
            actor: 'fixture',
            cardId: HYDRA_CARD,
            type: 'chat.message',
            data: {
              session: 'older-session',
              nativeId: 'archived-thinking',
              role: 'assistant',
              kind: 'thinking',
              hidden: false,
              text: 'kumquatinner',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'archived-hidden',
            at: '2026-01-01T00:00:02Z',
            actor: 'fixture',
            cardId: HYDRA_CARD,
            type: 'chat.message',
            data: {
              session: 'older-session',
              nativeId: 'archived-hidden',
              role: 'assistant',
              kind: 'message',
              hidden: true,
              text: 'xylophoneinjected',
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
    assert.deepEqual(
      find({ text: 'foxtrotspool' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'kumquatinner' }),
      [],
    )
    assert.deepEqual(
      find({ text: 'xylophoneinjected' }),
      [],
    )
  },
)

test(
  'a card titled with the query outranks a card that mentions it in many entries',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      scratch,
      'pnyx-oracle-rank-',
    ))
    const base = {
      v: 1 as const,
      actor: 'fixture',
      at: '2026-10-15T10:00:00Z',
    }
    const mentions: HydraEvent[] = Array.from(
      { length: MENTIONS },
      (
        _,
        entry,
      ) => ({
        ...base,
        seq: 0,
        id: `mention-${entry}`,
        cardId: 'task-chatty',
        type: 'card.noted',
        data: {
          text: 'Looked at the gazebo lantern again.',
          kind: 'context',
          source: 'fixture',
        },
      }),
    )
    const events: HydraEvent[] = [
      {
        ...base,
        seq: 0,
        id: 'created-chatty',
        cardId: 'task-chatty',
        type: 'task.created',
        data: {
          key: 'chatty',
          title: 'Long running work',
        },
      },
      ...mentions,
      {
        ...base,
        seq: 0,
        id: 'created-named',
        cardId: 'task-named',
        type: 'task.created',
        data: {
          key: 'named',
          title: 'Gazebo lantern',
        },
      },
    ]
    withWriter({
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
      },
    })
    assert.equal(
      search({
        hydraId: 'default',
        query: {
          text: 'gazebo lantern',
          limit: 20,
        },
      }).hits[0]?.card,
      'task-named',
    )
  },
)

test(
  'a word in more entries than a function call takes arguments still finds its card',
  () => {
    const home = mkdtempSync(join(
      scratch,
      'pnyx-oracle-long-',
    ))
    process.env.PNYX_HOME = home
    const transcriptPath = join(
      home,
      'long.jsonl',
    )
    writeFileSync(
      transcriptPath,
      Array.from(
        { length: LONG_HISTORY },
        () => JSON.stringify({
          type: 'user',
          timestamp: '2026-10-15T10:00:00Z',
          message: {
            role: 'user',
            content: 'zeppelin',
          },
        }),
      ).join('\n'),
    )
    const card = withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'long-created',
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
            cardId: 'long',
            type: 'task.created',
            data: {
              key: 'long',
              title: 'Long conversation',
            },
          },
        })
        const pushed = decidePush({
          state: writer.state,
          key: 'long',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'long-session',
              transcriptPath,
            },
          },
          meta: {
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
          },
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })

        return pushed.event.cardId
      },
    })
    assert.deepEqual(
      search({
        hydraId: 'default',
        query: {
          text: 'zeppelin',
          limit: 20,
        },
      }).hits.map(hit => hit.card),
      [card],
    )
  },
)
