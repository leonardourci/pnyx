import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { withWriter } from '../app/writer.ts'
import { search, updateIndex } from './index.ts'
import { redact, transcriptMessages } from './text.ts'

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
