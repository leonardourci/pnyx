import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { withMarker } from './marker.ts'

function fixture({
  t,
  total,
  pages,
  fail = false,
}: {
  t: test.TestContext
  total: number
  pages: {
    filename: string
    previous_filename?: string
  }[][]
  fail?: boolean
}) {
  const folder = mkdtempSync(join(
    tmpdir(),
    'pnyx-check-marker-',
  ))
  t.after(() => rmSync(
    folder,
    {
      recursive: true,
      force: true,
    },
  ))
  const calls = join(
    folder,
    'calls.jsonl',
  )
  const bootstrap = join(
    folder,
    'github.mjs',
  )
  const marker = {
    head_sha: 'fixture-head',
    head_tree: 'fixture-tree',
    finished_at: new Date(0).toISOString(),
  }
  const body = withMarker({
    body: '- [x] Ran `deslop`',
    marker,
  })
  writeFileSync(
    bootstrap,
    `
import { appendFileSync } from 'node:fs'
const pages = ${JSON.stringify(pages)}
globalThis.fetch = async url => {
  const endpoint = new URL(url).pathname + new URL(url).search
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(endpoint) + '\\n')
  if (endpoint === '/repos/fixture/repo/pulls/1') return { ok: true, json: async () => (${JSON.stringify({
    body,
    head: { sha: marker.head_sha },
    changed_files: total,
  })}) }
  const page = new URL(url).searchParams.get('page')
  if (!endpoint.startsWith('/repos/fixture/repo/pulls/1/files?') || !page) throw new Error('Unexpected endpoint: ' + endpoint)
  return { ok: ${!fail}, status: 502, json: async () => pages[Number(page) - 1] ?? [] }
}
`,
  )
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      bootstrap,
      resolve('scripts/verification/check-marker.ts'),
    ],
    {
      cwd: folder,
      env: {
        PATH: process.env.PATH,
        PNYX_HOME: join(
          folder,
          'pnyx',
        ),
        GITHUB_TOKEN: 'fixture',
        GITHUB_REPOSITORY: 'fixture/repo',
        PR_NUMBER: '1',
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  assert.ifError(result.error)

  return {
    status: result.status,
    output: result.stdout + result.stderr,
    calls: readFileSync(
      calls,
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line) as string),
  }
}

test(
  'forge marker reads every PR file page before deciding required reviews',
  t => {
    const docs = Array.from(
      { length: 100 },
      (
        _,
        i,
      ) => ({ filename: `docs/${i}.md` }),
    )
    const passing = fixture({
      t,
      total: 101,
      pages: [
        docs,
        [{ filename: 'README.md' }],
      ],
    })
    assert.equal(
      passing.status,
      0,
      passing.output,
    )
    assert.ok(passing.calls.some(call => call.endsWith('page=2')))
    const code = fixture({
      t,
      total: 101,
      pages: [
        docs,
        [{ filename: 'src/feature.ts' }],
      ],
    })
    assert.equal(
      code.status,
      1,
      code.output,
    )
    assert.match(
      code.output,
      /complete review-code/,
    )
  },
)

test(
  'forge marker counts both paths of a rename',
  t => {
    const result = fixture({
      t,
      total: 1,
      pages: [
        [
          {
            filename: 'docs/moved.md',
            previous_filename: 'src/feature.ts',
          },
        ],
      ],
    })
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.match(
      result.output,
      /complete review-code/,
    )
  },
)

test(
  'incomplete and capped PR file lists require all reviews',
  t => {
    for (const total of [
      2,
      3001,
    ]) {
      const result = fixture({
        t,
        total,
        pages: [[{ filename: 'README.md' }]],
      })
      assert.equal(
        result.status,
        1,
        result.output,
      )
      assert.match(
        result.output,
        /complete review-code/,
      )
      assert.equal(
        result.calls.some(call => call.includes('/files?')),
        total <= 3000,
      )
    }
  },
)

test(
  'a failed PR files request fails the marker check',
  t => {
    const result = fixture({
      t,
      total: 1,
      pages: [],
      fail: true,
    })
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.match(
      result.output,
      /HTTP 502/,
    )
  },
)
