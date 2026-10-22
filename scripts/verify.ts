// pnpm verify: runs every check even after one fails, prints one summary, and writes the
// checks marker for the PR head into the PR description only when all of them passed.
import {
  execFileSync,
  spawnSync,
} from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  markerBlockers,
  withMarker,
} from './marker.ts'

interface Step {
  name: string
  command: string
  args: string[]
  needs?: string
}

const STEPS: Step[] = [
  {
    name: 'lint:fix',
    command: 'pnpm',
    args: [
      'run',
      'lint:fix',
    ],
  },
  {
    name: 'typecheck',
    command: 'pnpm',
    args: [
      'run',
      'typecheck',
    ],
  },
  {
    name: 'eslint',
    command: 'pnpm',
    args: [
      'exec',
      'eslint',
      '.',
    ],
  },
  {
    name: 'build',
    command: 'pnpm',
    args: [
      'run',
      'build',
    ],
  },
  {
    name: 'unit tests',
    command: 'node',
    args: [
      '--test',
      'test/**/*.test.ts',
    ],
    needs: 'build',
  },
]
const LOGS = mkdtempSync(join(
  tmpdir(),
  'pnyx-verify-',
))

function read({ args }: { args: string[] }): string {
  return execFileSync(
    args[0],
    args.slice(1),
    {
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  ).trimEnd()
}

function changedPaths(): string[] {
  return read({
    args: [
      'git',
      'status',
      '--porcelain',
    ],
  }).split('\n')
    .filter(Boolean)
}

function head(): string {
  return read({
    args: [
      'git',
      'rev-parse',
      'HEAD',
    ],
  })
}

// The first line gh printed for a failed call.
function failure({ error }: { error: unknown }): string {
  const { stderr } = error as { stderr?: Buffer | string }

  return (stderr?.toString() || String(error)).trim().split('\n')[0]!
}

function openPullRequest(): {
  pullRequest?: {
    number: number
    headRefOid: string
    body: string
  }
  error?: string
} {
  try {
    return {
      pullRequest: JSON.parse(read({
        args: [
          'gh',
          'pr',
          'view',
          '--json',
          'number,headRefOid,body',
        ],
      })),
    }
  } catch (error) {
    return { error: failure({ error }) }
  }
}

// Each step's outcome: passed, or the reason it failed or was skipped.
function runStep({
  step,
  failed,
}: {
  step: Step
  failed: Set<string>
}): string {
  if (step.needs && failed.has(step.needs)) {
    return `skipped, ${step.needs} failed`
  }

  const log = join(
    LOGS,
    `${step.name.replaceAll(
      /\W+/g,
      '-',
    )}.log`,
  )
  const before = new Set(changedPaths())
  const fd = openSync(
    log,
    'w',
  )
  const { status } = spawnSync(
    step.command,
    step.args,
    {
      stdio: [
        'ignore',
        fd,
        fd,
      ],
    },
  )

  closeSync(fd)

  if (status !== 0) {
    return `failed, log ${log}`
  }

  const touched = changedPaths().filter(path => !before.has(path))

  if (touched.length > 0) {
    return `failed, it changed files to commit: ${touched.map(path => path.slice(3)).join(', ')}`
  }

  return 'passed'
}

const headSha = head()
const dirtyAtStart = changedPaths().length
const failed = new Set<string>()
const summary: string[] = []

for (const step of STEPS) {
  console.log(`verify: ${step.name}`)
  const outcome = runStep({
    step,
    failed,
  })

  if (outcome !== 'passed') {
    failed.add(step.name)
  }

  summary.push(`  ${step.name.padEnd(11)}${outcome}`)
}

// Read after the run, so an edit made to the description meanwhile is kept.
const found = openPullRequest()
const blockers = markerBlockers({
  failedSteps: failed.size,
  changedPaths: dirtyAtStart + changedPaths().length,
  headSha,
  headAfter: head(),
  pullRequestHead: found.pullRequest?.headRefOid,
})
let marker = `not written: ${[
  ...blockers,
  ...found.error ? [`gh pr view: ${found.error}`] : [],
].join('; ')}`

if (blockers.length === 0 && found.pullRequest) {
  const { pullRequest } = found

  try {
    execFileSync(
      'gh',
      [
        'pr',
        'edit',
        String(pullRequest.number),
        '--body-file',
        '-',
      ],
      {
        input: `${withMarker({
          body: pullRequest.body,
          marker: {
            head_sha: headSha,
            head_tree: read({
              args: [
                'git',
                'rev-parse',
                `${headSha}^{tree}`,
              ],
            }),
            finished_at: new Date().toISOString(),
          },
        })}\n`,
        stdio: [
          'pipe',
          'ignore',
          'pipe',
        ],
      },
    )
    marker = `written to PR #${pullRequest.number} for ${headSha}`
  } catch (error) {
    blockers.push('gh pr edit failed')
    marker = `not written: gh pr edit failed: ${failure({ error })}`
  }
}

console.log(`\nverify summary:\n${summary.join('\n')}\n  ${'marker'.padEnd(11)}${marker}`)
process.exitCode = blockers.length === 0 ? 0 : 1
