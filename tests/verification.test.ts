import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { select, validateConfig } from 'deslop/src/config.js'
import { parse } from 'yaml'
import { afterEach, expect, test } from 'vitest'
import { git } from './setup/upgrade.ts'
import { stagedBuild } from '../scripts/build/staged.ts'

const temporaryFolders: string[] = []
const CHILD_PROCESS_TIMEOUT_MS = 30_000

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) {
    rmSync(
      folder,
      {
        recursive: true,
        force: true,
      },
    )
  }
})

const policyRoot = fileURLToPath(new URL(
  '..',
  import.meta.url,
))
const config = validateConfig({
  root: policyRoot,
  config: JSON.parse(readFileSync(
    join(
      policyRoot,
      'deslop.config.json',
    ),
    'utf8',
  )),
})
const codeCommands = [
  'lint:fix',
  'typecheck',
  'css',
  'build',
]

test(
  'the shared verifier selects local commands and Pnyx review instructions',
  () => {
    const cases = [
      {
        path: 'src/app/server.ts',
        commands: codeCommands,
        instructions: [
          'review-code',
          'audit-tests',
          'kill-ai-slop',
          'project',
          'follow-conventions',
        ],
      },
      {
        path: 'docs/testing.md',
        commands: [],
        instructions: [
          'kill-ai-slop',
          'project',
        ],
      },
      {
        path: 'skills/pnyx-cli/SKILL.md',
        commands: [],
        instructions: [
          'kill-ai-slop',
          'project',
        ],
      },
      {
        path: 'tests/access.test.ts',
        commands: codeCommands,
        instructions: [
          'audit-tests',
          'project',
          'follow-conventions',
        ],
      },
      {
        path: 'web/src/hydra/hydra-chat.tsx',
        commands: codeCommands,
        instructions: [
          'review-code',
          'audit-tests',
          'kill-ai-slop',
          'project',
          'follow-conventions',
          'write-front-end',
        ],
      },
      {
        path: 'src/example/fixtures/input.md',
        commands: codeCommands,
        instructions: [
          'review-code',
          'audit-tests',
          'kill-ai-slop',
          'project',
          'follow-conventions',
        ],
      },
      {
        path: '.github/workflows/tests.yml',
        commands: codeCommands,
        instructions: [
          'review-code',
          'audit-tests',
          'kill-ai-slop',
          'project',
          'follow-conventions',
          'write-ci-workflow',
        ],
      },
    ]

    for (const {
      path,
      commands,
      instructions,
    } of cases) {
      const selected = select({
        config,
        paths: [path],
      })
      expect(
        selected.commands,
        path,
      ).toEqual(commands)
      expect(
        selected.instructions,
        path,
      ).toEqual(expect.arrayContaining(instructions))
      expect(
        selected.instructions,
        path,
      ).toHaveLength(instructions.length)
    }

    const selected = select({
      config,
      paths: [
        'docs/testing.md',
        'tests/access.test.ts',
        'web/src/hydra/hydra-chat.tsx',
        '.github/workflows/tests.yml',
      ],
    })
    expect(selected.commands).toEqual(codeCommands)
    expect(selected.checks).toEqual(expect.arrayContaining([
      'Test scope',
      'Lint, build and tests',
    ]))
    expect(selected.instructions).toEqual(expect.arrayContaining([
      'project',
      'follow-conventions',
      'review-code',
      'audit-tests',
      'kill-ai-slop',
      'write-front-end',
      'write-ci-workflow',
    ]))
  },
)

const workflow = parse(readFileSync(
  new URL(
    '../.github/workflows/tests.yml',
    import.meta.url,
  ),
  'utf8',
))
const scopeStep = workflow.jobs.scope.steps.find((step: { id?: string }) => step.id === 'scope')
const scopeScript = scopeStep.run

test(
  'every configured CI check names a workflow job',
  () => {
    const jobNames = Object.values(workflow.jobs).map(job => {
      if (typeof job !== 'object' || job === null || !('name' in job)) {
        throw new Error('Workflow job must have a name')
      }

      return job.name
    })

    for (const kind of config.kinds) {
      for (const check of kind.checks) {
        expect(jobNames).toContain(check)
      }
    }
  },
)

test.each([
  {
    name: 'ordinary docs',
    paths: [
      'docs/testing.md',
      '.github/workflows/README.md',
    ],
    output: 'tests=none\n',
    status: 0,
  },
  {
    name: 'docs with quoted or multiline filenames',
    paths: [
      'docs/naïve.md',
      'docs/line\nbreak.md',
      'docs/"quoted".md',
    ],
    output: 'tests=none\n',
    status: 0,
  },
  {
    name: 'source',
    paths: ['src/new.ts'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'source mixed with docs',
    paths: [
      'docs/testing.md',
      'src/new.ts',
    ],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'workflow',
    paths: ['.github/workflows/example.yml'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'shipped skills',
    paths: ['skills/pnyx-cli/SKILL.md'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'fixture Markdown',
    paths: ['skills/pnyx-cli/fixtures/input.md'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'check requirement without local commands or ciRequired',
    paths: ['docs/testing.md'],
    checkOnly: true,
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'code renamed into docs',
    paths: [],
    rename: true,
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'empty diff',
    paths: [],
    output: '',
    status: 1,
  },
  {
    name: 'unavailable config',
    paths: ['docs/testing.md'],
    missingConfig: true,
    output: '',
    status: 1,
  },
  {
    name: 'unavailable selector',
    paths: ['docs/testing.md'],
    missingSelector: true,
    output: '',
    status: 1,
  },
])(
  'CI scope handles $name from the merge diff',
  ({
    paths,
    rename = false,
    missingConfig = false,
    missingSelector = false,
    checkOnly = false,
    output,
    status,
  }) => {
    const runnerTemp = mkdtempSync(join(
      tmpdir(),
      'ci-scope-',
    ))
    temporaryFolders.push(runnerTemp)
    const root = join(
      runnerTemp,
      'repo',
    )
    mkdirSync(
      join(
        root,
        'src',
      ),
      { recursive: true },
    )
    const configPath = join(
      root,
      'deslop.config.json',
    )
    const scopeConfig = JSON.parse(readFileSync(
      join(
        policyRoot,
        'deslop.config.json',
      ),
      'utf8',
    ))

    if (checkOnly) {
      scopeConfig.kinds = [
        {
          name: 'check only',
          match: ['**'],
          commands: [],
          checks: ['Lint, build and tests'],
          instructions: [],
        },
      ]
    }

    writeFileSync(
      configPath,
      JSON.stringify(scopeConfig),
    )
    writeFileSync(
      join(
        root,
        'src/old.ts',
      ),
      'export {}\n',
    )
    git({
      cwd: root,
      args: [
        'init',
        '--initial-branch=main',
      ],
    })
    git({
      cwd: root,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: root,
      args: [
        'commit',
        '-m',
        'base',
      ],
    })
    git({
      cwd: root,
      args: [
        'switch',
        '-c',
        'change',
      ],
    })

    for (const path of paths) {
      mkdirSync(
        dirname(join(
          root,
          path,
        )),
        { recursive: true },
      )
      writeFileSync(
        join(
          root,
          path,
        ),
        'fixture\n',
      )
    }

    if (rename) {
      mkdirSync(join(
        root,
        'docs',
      ))
      git({
        cwd: root,
        args: [
          'mv',
          'src/old.ts',
          'docs/renamed.md',
        ],
      })
    }

    if (missingConfig) {
      rmSync(configPath)
    }

    git({
      cwd: root,
      args: [
        'add',
        '-A',
      ],
    })
    git({
      cwd: root,
      args: [
        'commit',
        '--allow-empty',
        '-m',
        'change',
      ],
    })
    git({
      cwd: root,
      args: [
        'switch',
        'main',
      ],
    })
    git({
      cwd: root,
      args: [
        'merge',
        '--no-ff',
        'change',
        '-m',
        'merge',
      ],
    })
    const modules = join(
      runnerTemp,
      'deslop-scope/node_modules',
    )
    mkdirSync(
      modules,
      { recursive: true },
    )
    symlinkSync(
      fileURLToPath(new URL(
        missingSelector ? '../missing-selector' : '../node_modules/deslop',
        import.meta.url,
      )),
      join(
        modules,
        'deslop',
      ),
    )
    const outputPath = join(
      runnerTemp,
      'output',
    )
    const result = spawnSync(
      '/bin/bash',
      [
        '-e',
        '-o',
        'pipefail',
        '-c',
        scopeScript,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: CHILD_PROCESS_TIMEOUT_MS,
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: outputPath,
        },
      },
    )
    expect(
      result.status,
      result.stderr,
    ).toBe(status)
    expect(result.stdout).toBe(output)
    expect(readFileSync(
      outputPath,
      'utf8',
    )).toBe(output)
  },
)

// A failed build must leave the last working dist, which every upgrade's rollback and every test run on it.
test(
  'a passing build replaces dist and leaves nothing beside it, and a failing build keeps the old dist',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'staged-',
    ))
    temporaryFolders.push(root)
    const writeBuild = ({
      version,
      fail = false,
    }: {
      version: string
      fail?: boolean
    }) => stagedBuild({
      root,
      build: ({ out }) => {
        mkdirSync(out)
        writeFileSync(
          join(
            out,
            'built.txt',
          ),
          version,
        )

        if (fail) {
          throw new Error('type error')
        }
      },
    })
    const built = () => readFileSync(
      join(
        root,
        'dist',
        'built.txt',
      ),
      'utf8',
    )

    writeBuild({ version: 'one' })
    writeBuild({ version: 'two' })
    expect(built()).toBe('two')
    expect(readdirSync(root)).toEqual(['dist'])

    expect(() => writeBuild({
      version: 'broken',
      fail: true,
    })).toThrow('type error')
    expect(built()).toBe('two')
    expect(readdirSync(root)).toEqual(['dist'])
  },
)
