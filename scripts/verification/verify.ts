import {
  execFileSync,
  spawnSync,
} from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  markerBlockers,
  withMarker,
} from './marker.ts'
import { requiredChecks, mechanicalDeclaration, REVIEW_CHECKLISTS, type Review } from './required-checks.ts'

const args = process.argv.slice(2)

if (args.some(arg => ![
  '--checks-only',
  '--mechanical',
].includes(arg))) {
  console.error('Usage: pnpm verify [--checks-only | --mechanical]')
  process.exit(1)
}

const checksOnly = args.includes('--checks-only')
const mechanical = args.includes('--mechanical')

if (checksOnly && mechanical) {
  console.error('verify: --mechanical requires a PR description; use it without --checks-only.')
  process.exit(1)
}

interface Step {
  name: string
  command: string
  args: string[]
  needs?: string
}

const STATIC_CHECKS: Step[] = [
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
]
const BUILD_STEP: Step = {
  name: 'build',
  command: 'pnpm',
  args: [
    'run',
    'build',
  ],
}
const EVERYTHING: Step[] = [
  ...STATIC_CHECKS,
  BUILD_STEP,
  {
    name: 'unit tests',
    command: 'node',
    args: [
      'scripts/verification/test.ts',
      'unit',
    ],
    needs: 'build',
  },
  // One file at a time, so at most the test process and one pnyx-axi run at once.
  {
    name: 'scenarios',
    command: 'node',
    args: [
      'scripts/verification/test.ts',
      'scenarios',
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
function branchChanges({ defaultRef }: { defaultRef: string }): string[] | undefined {
  let base: string

  try {
    base = read({
      args: [
        'git',
        'merge-base',
        'HEAD',
        defaultRef,
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
          '-z',
          base,
        ],
      }).split('\0'),
      ...read({
        args: [
          'git',
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
        ],
      }).split('\0'),
    ].filter(Boolean)),
  ]
}

function selection({ defaultRef }: { defaultRef: string }) {
  const paths = branchChanges({ defaultRef })
  const required = requiredChecks({
    paths,
    mechanical,
  })

  if (required.tests === 'full') {
    return {
      ...required,
      steps: EVERYTHING,
    }
  }

  const tests = new Set<string>()
  let testName = 'changed tests'

  if (required.tests === 'skills') {
    testName = 'skill tests'

    for (const path of SKILL_TESTS) {
      tests.add(path)
    }
  }

  for (const path of required.changedTests) {
    if (existsSync(path)) {
      tests.add(path)
    }
  }

  const steps: Step[] = []

  if (required.changedTests.length > 0) {
    steps.push(...STATIC_CHECKS)
  }

  if (tests.size > 0) {
    steps.push(
      BUILD_STEP,
      {
        name: testName,
        command: 'node',
        args: [
          'scripts/verification/test.ts',
          ...tests,
        ],
        needs: 'build',
      },
    )
  }

  return {
    ...required,
    steps,
  }
}

// These exercise installation, generated contracts, catalog text and worker conventions.
const SKILL_TESTS = [
  'test/skills.test.ts',
  'test/skills-cli.test.ts',
  'test/start.test.ts',
  'test/task-context.test.ts',
  'test/hydra-host.test.ts',
  'test/catalog.test.ts',
  'test/catalog-server.test.ts',
  'test/setup-check.test.ts',
  'test/scenarios/hydra.test.ts',
  'test/scenarios/worker-conventions.test.ts',
]

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
    if (step.name === 'lint:fix' || step.name === 'eslint') {
      console.log(`verify: ${step.name} could not resolve these issues:\n${readFileSync(
        log,
        'utf8',
      )}`)
    }

    return `failed, log ${log}`
  }

  const touched = changedPaths().filter(path => !before.has(path))

  if (touched.length > 0) {
    return `failed, it changed files to commit: ${touched.map(path => path.slice(3)).join(', ')}`
  }

  return 'passed'
}

function printReviews({ reviews = REVIEW_CHECKLISTS }: { reviews?: readonly Review[] } = {}): void {
  console.log('\nReview checklists, in order:')

  for (const name of reviews) {
    console.log(`  ${name}: .agents/skills/${name}/SKILL.md`)
  }

  console.log('Whoever runs verify completes these checklists, ticks the required PR boxes, and notes fixes or no findings in the PR description. Agents perform these steps themselves. Commit and push any fixes, then rerun verify on the clean PR head.')
}

function updateDefaultBranch(): string {
  const remote = read({
    args: [
      'git',
      'ls-remote',
      '--symref',
      'origin',
      'HEAD',
    ],
  })
  const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(remote)?.[1]

  if (!branch) {
    throw new Error('Could not determine origin\'s default branch; no checks ran.')
  }

  const defaultRef = `refs/remotes/origin/${branch}`
  read({
    args: [
      'git',
      'fetch',
      'origin',
      `+refs/heads/${branch}:${defaultRef}`,
    ],
  })
  const { status } = spawnSync(
    'git',
    [
      'merge-base',
      '--is-ancestor',
      defaultRef,
      'HEAD',
    ],
  )

  if (status !== 0) {
    throw new Error(`Branch is behind ${defaultRef}. Rebase it yourself, then rerun verify:\n  git rebase ${defaultRef}`)
  }

  return defaultRef
}

let defaultRef: string

try {
  defaultRef = updateDefaultBranch()
} catch (error) {
  console.error(`verify: ${error instanceof Error ? error.message : String(error)}`)
  printReviews()
  process.exit(1)
}

const headSha = head()
const dirtyAtStart = changedPaths().length
const failed = new Set<string>()
const summary: string[] = []

const {
  steps,
  why,
  reviews,
  groups,
} = selection({ defaultRef })

for (const [
  kind,
  paths,
] of Object.entries(groups)) {
  console.log(`verify: ${kind}: ${paths.join(', ')}`)
}

console.log(`verify: required reviews: ${reviews.join(', ')}`)

if (mechanical) {
  const found = openPullRequest()

  if (!found.pullRequest || !mechanicalDeclaration({ body: found.pullRequest.body })) {
    console.error('verify: --mechanical requires a visible PR line: Change: mechanical (rename) or Change: mechanical (move).')
    process.exit(1)
  }
}

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

if (checksOnly) {
  const dirty = changedPaths()
  const headMoved = head() !== headSha

  if (dirty.length > 0) {
    summary.push(`  worktree       failed, uncommitted changes: ${dirty.map(path => path.slice(3)).join(', ')}`)
  }

  if (headMoved) {
    summary.push('  HEAD           failed, HEAD moved during the run')
  }

  console.log(`\nverify summary:\n${summary.join('\n')}\n  marker         not written: --checks-only`)
  printReviews({ reviews })
  process.exitCode = failed.size === 0 && dirty.length === 0 && !headMoved ? 0 : 1
} else {
  // Read after the run, so an edit made to the description meanwhile is kept.
  const found = openPullRequest()
  const blockers = markerBlockers({
    requiredReviews: reviews,
    mechanical,
    failedSteps: failed.size,
    changedPaths: dirtyAtStart + changedPaths().length,
    headSha,
    headAfter: head(),
    pullRequestHead: found.pullRequest?.headRefOid,
    pullRequestBody: found.pullRequest?.body ?? '',
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
              ...mechanical ? { mechanical: true } : {},
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
  printReviews({ reviews })
  process.exitCode = blockers.length === 0 ? 0 : 1
}
