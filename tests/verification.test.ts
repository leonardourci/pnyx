import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const selectorModule = pathToFileURL(createRequire(import.meta.url).resolve('deslop/src/config.js')).href
const policyRoot = fileURLToPath(new URL(
  '..',
  import.meta.url,
))
const selectionProgram = `
import { readFileSync } from 'node:fs';
import { select, validateConfig, instructionsFor } from ${JSON.stringify(selectorModule)};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { root, paths } = JSON.parse(input);
const config = validateConfig({ root, config: JSON.parse(readFileSync(root + '/deslop.config.json', 'utf8')) });
const selected = select({ config, paths });
console.log(JSON.stringify({ ...selected, reviewText: instructionsFor({ root, config, selection: selected }) }));
`
interface Selection {
  commands: string[]
  checks: string[]
  requiredChecks: string[]
  instructions: string[]
  reviewText: string
}

test(
  'the shared verifier selects the Pnyx checks and review skills for each changed kind',
  () => {
    const selection = ({ paths }: { paths: string[] }): Selection => JSON.parse(execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        selectionProgram,
      ],
      {
        input: JSON.stringify({
          root: policyRoot,
          paths,
        }),
        encoding: 'utf8',
        timeout: CHILD_PROCESS_TIMEOUT_MS,
      },
    ))
    const config = JSON.parse(readFileSync(
      new URL(
        '../deslop.config.json',
        import.meta.url,
      ),
      'utf8',
    ))
    expect(config.publishLocal).toBe(false)
    const reviewText = selection({ paths: ['src/app/server.ts'] }).reviewText
    expect(reviewText).toContain(readFileSync(
      join(
        policyRoot,
        'AGENTS.md',
      ),
      'utf8',
    ))
    expect(reviewText).toContain(readFileSync(
      join(
        policyRoot,
        '.agents/skills/review-code/SKILL.md',
      ),
      'utf8',
    ))
    expect(reviewText).toContain(readFileSync(
      join(
        policyRoot,
        '.agents/skills/audit-tests/SKILL.md',
      ),
      'utf8',
    ))
    expect(reviewText).toContain(readFileSync(
      join(
        policyRoot,
        '.agents/skills/deslop/SKILL.md',
      ),
      'utf8',
    ))
    expect(selection({ paths: ['src/app/server.ts'] }).requiredChecks).toEqual(['Lint, build and tests'])
    expect(selection({ paths: ['src/app/server.ts'] }).commands).toEqual([
      'lint:fix',
      'typecheck',
      'eslint',
      'css',
      'build',
    ])
    expect(selection({ paths: ['docs/testing.md'] }).requiredChecks).toEqual([])

    expect(selection({ paths: ['docs/testing.md'] })).toMatchObject({
      commands: [],
      checks: ['Test scope'],
      instructions: [
        'kill-ai-slop',
        'project',
      ],
    })
    expect(selection({ paths: ['.github/workflows/README.md'] }).commands).toEqual([])
    expect(selection({ paths: ['README.md'] })).toMatchObject({
      commands: [],
      checks: ['Test scope'],
    })
    expect(selection({ paths: ['skills/pnyx-cli/SKILL.md'] })).toMatchObject({
      commands: ['build'],
      checks: ['Lint, build and tests'],
      instructions: [
        'kill-ai-slop',
        'project',
      ],
    })
    expect(selection({ paths: ['tests/access.test.ts'] }).requiredChecks).toContain('Lint, build and tests')
    expect(selection({ paths: ['web/src/hydra/hydra-chat.tsx'] }).instructions).toContain('write-front-end')
    expect(selection({ paths: ['tests/setup/pnyx.ts'] }).requiredChecks).toContain('Lint, build and tests')
    expect(selection({ paths: ['src/example/fixtures/input.md'] })).toMatchObject({
      commands: [
        'lint:fix',
        'typecheck',
        'eslint',
        'css',
        'build',
      ],
      checks: ['Lint, build and tests'],
      instructions: [
        'review-code',
        'audit-tests',
        'kill-ai-slop',
        'project',
      ],
    })
    expect(selection({ paths: ['skills/pnyx-cli/fixtures/input.md'] })).toMatchObject({
      commands: [
        'lint:fix',
        'typecheck',
        'eslint',
        'css',
        'build',
      ],
      checks: ['Lint, build and tests'],
      instructions: [
        'review-code',
        'audit-tests',
        'kill-ai-slop',
        'project',
      ],
    })
    expect(selection({ paths: ['vitest.config.ts'] }).requiredChecks).toContain('Lint, build and tests')
    expect(selection({ paths: ['.github/workflows/tests.yml'] }).requiredChecks).toContain('Lint, build and tests')
    expect(selection({ paths: ['.github/workflows/tests.yml'] }).instructions).toContain('write-ci-workflow')
    expect(selection({
      paths: [
        'docs/testing.md',
        'src/app/server.ts',
      ],
    }).requiredChecks).toContain('Lint, build and tests')
  },
)

const workflow = parse(readFileSync(
  new URL(
    '../.github/workflows/tests.yml',
    import.meta.url,
  ),
  'utf8',
))
const scopeScript = workflow.jobs.scope.steps.find((step: { id?: string }) => step.id === 'scope').run

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
    name: 'source',
    paths: ['src/new.ts'],
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
    writeFileSync(
      configPath,
      readFileSync(join(
        policyRoot,
        'deslop.config.json',
      )),
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
