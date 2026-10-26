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
  REVIEW_CHECKLISTS,
  withMarker,
} from './marker.ts'

const args = process.argv.slice(2)

if (args.some(arg => arg !== '--checks-only')) {
  console.error('Usage: pnpm verify [--checks-only]')
  process.exit(1)
}

const checksOnly = args.includes('--checks-only')

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
      'scripts/test.ts',
      'unit',
    ],
    needs: 'build',
  },
  // One file at a time, so at most the test process and one pnyx-axi run at once.
  {
    name: 'scenarios',
    command: 'node',
    args: [
      'scripts/test.ts',
      'scenarios',
    ],
    needs: 'build',
  },
]

// Tests of web/ code: those importing it, and the browser journeys that load the built page.
const WEB_TEST_IMPORT = /from '((\.\.\/)+web\/|\.\/browser\.ts')/

function webTests({ folder }: { folder: string }): string[] {
  return readdirSync(folder)
    .map(name => `${folder}/${name}`)
    .filter(path => path.endsWith('.test.ts') && WEB_TEST_IMPORT.test(readFileSync(
      path,
      'utf8',
    )))
}

// UI checks: the static checks plus every test of web/ code, browser journeys included.
function uiSteps(): Step[] {
  const units = webTests({ folder: 'test' })
  const scenarios = webTests({ folder: 'test/scenarios' })

  return [
    ...CHECKS,
    ...units.length ? [
      {
        name: 'web unit tests',
        command: 'node',
        args: [
          'scripts/test.ts',
          ...units,
        ],
        needs: 'build',
      },
    ] : [],
    ...scenarios.length ? [
      {
        name: 'web scenarios',
        command: 'node',
        args: [
          'scripts/test.ts',
          ...scenarios,
        ],
        needs: 'build',
      },
    ] : [],
  ]
}

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
          base,
        ],
      }).split('\n'),
      ...changedPaths().flatMap(line => line.slice(3).split(' -> ')),
    ].filter(Boolean)),
  ]
}

// Markdown outside the shipped skills and the tests is docs.
function area({ path }: { path: string }): string {
  if (path.endsWith('.md') && !/^(skills|test)\//.test(path)) {
    return 'docs'
  }

  return path.startsWith('web/') ? 'UI' : 'back-end'
}

// Back-end changes (or both) run everything, UI-only changes the UI checks, docs-only changes nothing.
function selection({ defaultRef }: { defaultRef: string }): {
  steps: Step[]
  why: string
} {
  const paths = branchChanges({ defaultRef })

  if (!paths?.length) {
    return {
      steps: EVERYTHING,
      why: paths ? `no changes from ${defaultRef} found` : `${defaultRef} is not available to compare with`,
    }
  }

  const byArea = new Map<string, string[]>()

  for (const path of paths) {
    byArea.set(
      area({ path }),
      [
        ...byArea.get(area({ path })) ?? [],
        path,
      ],
    )
  }

  const named = ({ kind }: { kind: string }) => {
    const found = byArea.get(kind)!

    return `${found.length} ${kind} (${found.slice(
      0,
      3,
    ).join(', ')}${found.length > 3 ? ', …' : ''})`
  }

  if (byArea.has('back-end')) {
    return {
      steps: EVERYTHING,
      why: `${named({ kind: 'back-end' })} changed`,
    }
  }

  return byArea.has('UI')
    ? {
      steps: uiSteps(),
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

function printReviews(): void {
  console.log('\nReview checklists, in order:')

  for (const name of REVIEW_CHECKLISTS) {
    console.log(`  ${name}: .agents/skills/${name}/SKILL.md`)
  }

  console.log('Whoever runs verify completes these checklists, ticks the three PR boxes, and notes fixes or no findings in the PR description. Agents perform these steps themselves. Commit and push any fixes, then rerun verify on the clean PR head.')
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
} = selection({ defaultRef })
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
  printReviews()
  process.exitCode = failed.size === 0 && dirty.length === 0 && !headMoved ? 0 : 1
} else {
  // Read after the run, so an edit made to the description meanwhile is kept.
  const found = openPullRequest()
  const blockers = markerBlockers({
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
  printReviews()
  process.exitCode = blockers.length === 0 ? 0 : 1
}
