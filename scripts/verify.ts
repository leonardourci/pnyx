// pnpm verify: picks the checks the branch's changed files need, runs each even after one fails,
// prints one summary, and writes the checks marker for the PR head into the PR description only
// when all of them passed.
import {
  execFileSync,
  spawnSync,
} from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
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

const CHECKS: Step[] = [
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
]
const EVERYTHING: Step[] = [
  ...CHECKS,
  {
    name: 'unit tests',
    command: 'node',
    args: [
      '--test',
      'test/*.test.ts',
    ],
    needs: 'build',
  },
  // One file at a time, so at most the test process and one pnyx-axi run at once.
  {
    name: 'scenarios',
    command: 'node',
    args: [
      '--test',
      '--test-concurrency=1',
      'test/scenarios/*.test.ts',
    ],
    needs: 'build',
  },
]

// The unit tests that import the web Hydra's code.
function webTests(): string[] {
  return readdirSync('test')
    .filter(name => name.endsWith('.test.ts') && readFileSync(
      join(
        'test',
        name,
      ),
      'utf8',
    ).includes('from \'../web/'))
    .map(name => `test/${name}`)
}

// The browser journeys join these when they land.
const UI = (): Step[] => [
  ...CHECKS,
  {
    name: 'web unit tests',
    command: 'node',
    args: [
      '--test',
      ...webTests(),
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

// The branch's files that differ from the default branch, committed or not.
function branchChanges(): string[] | undefined {
  let base: string

  try {
    base = read({
      args: [
        'git',
        'merge-base',
        'HEAD',
        'origin/main',
      ],
    })
  } catch {
    return undefined
  }

  return [
    ...new Set([
      ...read({
        args: [
          'git',
          'diff',
          '--name-only',
          '--no-renames',
          base,
        ],
      }).split('\n'),
      ...changedPaths().flatMap(line => line.slice(3).split(' -> ')),
    ].filter(Boolean)),
  ]
}

// Markdown outside the shipped skills and the tests is docs, as the Checks required workflow skips it.
const area = ({ path }: { path: string }) => path.endsWith('.md') && !/^(skills|test)\//.test(path) ? 'docs'
  : path.startsWith('web/') ? 'UI' : 'back-end'

// Back-end changes (or both) run everything, UI-only changes the UI checks, docs-only changes nothing.
function selection(): {
  steps: Step[]
  why: string
} {
  const paths = branchChanges()

  if (!paths?.length) {
    return {
      steps: EVERYTHING,
      why: paths ? 'no changes from origin/main found' : 'origin/main is not available to compare with',
    }
  }

  const named = ({ kind }: { kind: string }) => {
    const found = paths.filter(path => area({ path }) === kind)

    return `${found.length} ${kind} (${found.slice(
      0,
      3,
    ).join(', ')}${found.length > 3 ? ', …' : ''})`
  }

  const has = ({ kind }: { kind: string }) => paths.some(path => area({ path }) === kind)

  if (has({ kind: 'back-end' })) {
    return {
      steps: EVERYTHING,
      why: `${named({ kind: 'back-end' })} changed`,
    }
  }

  return has({ kind: 'UI' })
    ? {
      steps: UI(),
      why: `only UI and docs changed: ${named({ kind: 'UI' })}`,
    }
    : {
      steps: [],
      why: `only docs changed: ${named({ kind: 'docs' })}`,
    }
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

const {
  steps,
  why,
} = selection()
console.log(`verify: ${steps.length ? `running ${steps.map(step => step.name).join(', ')}` : 'running no checks'}; ${why}`)

for (const step of steps) {
  console.log(`verify: ${step.name}`)
  const outcome = runStep({
    step,
    failed,
  })

  if (outcome !== 'passed') {
    failed.add(step.name)
  }

  summary.push(`  ${step.name.padEnd(15)}${outcome}`)
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

console.log(`\nverify summary:\n${summary.join('\n')}\n  ${'marker'.padEnd(15)}${marker}`)
process.exitCode = blockers.length === 0 ? 0 : 1
