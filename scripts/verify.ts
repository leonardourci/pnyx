// pnpm verify: runs every check even after one fails, prints one summary, and writes the
// checks marker for the PR head into the PR description only when all of them passed.
import {
  execFileSync,
  spawnSync,
} from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withMarker } from './marker.ts'

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
const LOGS = join(
  tmpdir(),
  'pnyx-verify',
)

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
  ).trim()
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

function openPullRequest(): {
  number: number
  headRefOid: string
  body: string
} | undefined {
  try {
    return JSON.parse(read({
      args: [
        'gh',
        'pr',
        'view',
        '--json',
        'number,headRefOid,body',
      ],
    }))
  } catch {
    return undefined
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

mkdirSync(
  LOGS,
  { recursive: true },
)

const headSha = head()
const pullRequest = openPullRequest()
const blockers = [
  changedPaths().length > 0 ? 'the tree has uncommitted changes' : '',
  pullRequest ? '' : 'no open PR for this branch (gh pr view failed)',
  pullRequest && pullRequest.headRefOid !== headSha ? `HEAD ${headSha} is not the PR head ${pullRequest.headRefOid}, push first` : '',
].filter(Boolean)
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

if (head() !== headSha) {
  blockers.push('HEAD moved during the run')
}

if (failed.size > 0) {
  blockers.unshift(`${failed.size} step(s) failed`)
}

let marker = `not written: ${blockers.join('; ')}`

if (blockers.length === 0 && pullRequest) {
  const body = withMarker({
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
  })

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
      input: `${body}\n`,
      stdio: [
        'pipe',
        'ignore',
        'inherit',
      ],
    },
  )
  marker = `written to PR #${pullRequest.number} for ${headSha}`
}

console.log(`\nverify summary:\n${summary.join('\n')}\n  ${'marker'.padEnd(11)}${marker}`)
process.exitCode = blockers.length === 0 ? 0 : 1
