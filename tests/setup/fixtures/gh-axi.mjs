#!/usr/bin/env node
// gh-axi for tests: reads each pull request from $PNYX_FAKE_GITHUB/<owner>/<repo>/<n>.json and logs every call.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = process.env.PNYX_FAKE_GITHUB
appendFileSync(
  join(
    root,
    'calls.jsonl',
  ),
  `${JSON.stringify(args)}\n`,
)
const api = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(args[0] === 'api' ? args[1] : '')
const repo = api?.[1] ?? args[args.indexOf('--repo') + 1]
const number = api?.[2] ?? args[2]
const file = join(
  root,
  repo ?? '',
  `${number}.json`,
)

if (!repo || !existsSync(file) || !(api || (args[0] === 'pr' && args[1] === 'view'))) {
  console.log(`error: "Item #${number} does not exist in this repository"\ncode: NOT_FOUND`)
  process.exit(1)
}

const pr = JSON.parse(readFileSync(
  file,
  'utf8',
))
const merged = pr.state === 'merged'

if (api) {
  console.log(`payload: ${JSON.stringify(JSON.stringify({
    head: {
      sha: 'a'.repeat(40),
      ref: pr.branch ?? 'feature',
    },
    base: { ref: 'main' },
    merged,
    merge_commit_sha: merged ? 'b'.repeat(40) : null,
    state: pr.state === 'open' ? 'open' : 'closed',
    draft: Boolean(pr.draft),
  }))}`)
} else {
  console.log(`pull_request:
  number: ${number}
  title: ${JSON.stringify(pr.title ?? `Pull request ${number}`)}
  state: ${pr.state}
  draft: ${pr.draft ? 'yes' : 'no'}
  checks: ${JSON.stringify(pr.checks ?? '0 passed, 0 failed')}
  comment_count: ${pr.comments ?? 0}
  review_count: 0`)
}
