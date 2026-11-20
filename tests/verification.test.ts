import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { afterEach, expect, test } from 'vitest'
import { git } from './setup/upgrade.ts'
import { stagedBuild } from '../scripts/build/staged.ts'
import { ESLint } from 'eslint'

const temporaryFolders: string[] = []
const CHILD_PROCESS_TIMEOUT_MS = 30_000

test(
  'web lint rejects one-off styles and unsorted classes while accepting tokens and runtime geometry',
  async () => {
    const linter = new ESLint()
    const cases = [
      {
        source: 'classList.add("w-[317px]")',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: 'element.classList.add("w-[317px]")',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: 'element.style.width = `${measuredWidth}px`',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'element["style"].width = "317px"',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'applyRuntimeStyle({ element, values: { left: 317 } })',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'applyRuntimeStyle({ element, "values": { left: 317 } })',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'applyRuntimeStyle({ element, values: { left: -317 } })',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'applyRuntimeStyle({ element, values: { left: `317px` } })',
        rule: 'no-restricted-syntax',
      },
      {
        source: '<div className="text-sm/[17px]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className={`text-sm/[${height}px]`} />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div style={runtimeStyle({ left: -317 })} />',
        rule: 'no-restricted-syntax',
      },
      {
        source: '<div style={runtimeStyle({ left: +317 })} />',
        rule: 'no-restricted-syntax',
      },
      {
        source: '<div style={runtimeStyle({ left: `317px` })} />',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'const itemClassName = "text-ink flex"; <div className={itemClassName} />',
        rule: 'better-tailwindcss/enforce-consistent-class-order',
      },
      {
        source: '<Tooltip anchorClassName="w-[317px]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className={`w-[${width}px]`} />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className={`[width:${width}px]`} />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<Tooltip anchorClassName="text-ink flex" />',
        rule: 'better-tailwindcss/enforce-consistent-class-order',
      },
      {
        source: '<div className="bg-[#123456]/50" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className="w-[317px]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className="hover:w-[317px]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className="[color:red]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className="[--card2_width:317px]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className="![color:red]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div className="[grid-template-columns:[start]_1fr_[end]]" />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: 'const ITEM_CLASSES = "w-[317px]"; <div className={ITEM_CLASSES} />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: 'const narrow = "w-[317px]"; <div className={narrow} />',
        rule: 'better-tailwindcss/no-restricted-classes',
      },
      {
        source: '<div style={{ width: 317 }} />',
        rule: 'no-restricted-syntax',
      },
      {
        source: '<div style="width: 317px" />',
        rule: 'no-restricted-syntax',
      },
      {
        source: 'const style = { width: 317 }; <div style={style} />',
        rule: 'no-restricted-syntax',
      },
      {
        source: '<div style={runtimeStyle({ width: 317 })} />',
        rule: 'no-restricted-syntax',
      },
      {
        source: '<div className="text-ink flex" />',
        rule: 'better-tailwindcss/enforce-consistent-class-order',
      },
    ]

    for (const {
      source,
      rule,
    } of cases) {
      const reports = await linter.lintText(
        source,
        { filePath: 'web/src/shared/ui/lint-policy.tsx' },
      )
      const messages = reports.flatMap(report => report.messages)
      expect(
        messages.map(message => message.ruleId),
        source,
      ).toContain(rule)
    }

    const valid = 'const width = window.innerWidth; const element = document.createElement("div"); applyRuntimeStyle({ element, values: { width, maxHeight: width } }); element.classList.add("flex", "text-ink"); <div className="flex w-card-chat text-ink hover:text-gold [&>span]:truncate" style={runtimeStyle({ width, left: -width, top: +width, fontSize: `${width}px` })} />'
    const reports = await linter.lintText(
      valid,
      { filePath: 'web/src/shared/ui/lint-policy.tsx' },
    )
    const policyRules = new Set([
      'better-tailwindcss/no-restricted-classes',
      'better-tailwindcss/enforce-consistent-class-order',
      'no-restricted-syntax',
    ])
    const messages = reports.flatMap(report => report.messages)
    const violations = messages.filter(message =>
      message.fatal || (message.ruleId !== null && policyRules.has(message.ruleId)))
    expect(violations).toEqual([])
  },
)

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

const require = createRequire(import.meta.url)
const selectorPath = require.resolve('deslop/src/config.ts')
const selectorModule = pathToFileURL(selectorPath).href
const {
  select,
  validateConfig,
  instructionsFor,
} = await import(selectorModule)
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
          'follow-conventions',
        ],
      },
      {
        path: 'skills/pnyx-cli/SKILL.md',
        commands: [],
        instructions: [
          'kill-ai-slop',
          'project',
          'follow-conventions',
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
    const reviewText = instructionsFor({
      root: policyRoot,
      config,
      selection: selected,
    })

    for (const file of [
      'AGENTS.md',
      '.agents/skills/follow-conventions/SKILL.md',
      '.agents/skills/write-front-end/SKILL.md',
      '.agents/skills/write-ci-workflow/SKILL.md',
    ]) {
      expect(reviewText).toContain(readFileSync(
        join(
          policyRoot,
          file,
        ),
        'utf8',
      ))
    }
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
    name: 'test-only changes',
    paths: ['tests/access.test.ts'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'shared test setup',
    paths: ['tests/setup/pnyx.ts'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'test configuration',
    paths: ['vitest.config.ts'],
    output: 'tests=all\n',
    status: 0,
  },
  {
    name: 'hidden configuration',
    paths: ['.coderabbit.yaml'],
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
