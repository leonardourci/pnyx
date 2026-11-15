import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { afterEach, expect, test } from 'vitest'
import { stagedBuild } from '../scripts/build/staged.ts'

const temporaryFolders: string[] = []

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
import { select, validateConfig } from ${JSON.stringify(selectorModule)};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { root, paths } = JSON.parse(input);
const config = validateConfig({ root, config: JSON.parse(readFileSync(root + '/deslop.config.json', 'utf8')) });
console.log(JSON.stringify(select({ config, paths })));
`
interface Selection {
  commands: string[]
  checks: string[]
  requiredChecks: string[]
  instructions: string[]
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
    expect(selection({ paths: ['src/app/server.ts'] }).requiredChecks).toEqual(['Lint, build and tests'])
    expect(selection({ paths: ['docs/testing.md'] }).requiredChecks).toEqual([])

    expect(selection({ paths: ['docs/testing.md'] })).toMatchObject({
      commands: [],
      checks: ['Lint, build and tests'],
      instructions: [
        'project',
        'deslop',
      ],
    })
    expect(selection({ paths: ['.github/workflows/README.md'] }).commands).toEqual([])
    expect(selection({ paths: ['README.md'] })).toMatchObject({
      commands: [],
      checks: ['Lint, build and tests'],
    })
    expect(selection({ paths: ['skills/pnyx-cli/SKILL.md'] })).toMatchObject({
      commands: [
        'build',
        'integration',
      ],
      checks: ['Lint, build and tests'],
      instructions: [
        'project',
        'deslop',
      ],
    })
    expect(selection({ paths: ['tests/access.test.ts'] }).commands).toContain('tests')
    expect(selection({ paths: ['web/src/hydra/hydra-chat.tsx'] }).instructions).toContain('write-front-end')
    expect(selection({ paths: ['src/app/server.ts'] }).commands).toContain('tests')
    expect(selection({ paths: ['tests/setup/pnyx.ts'] }).commands).toContain('tests')
    expect(selection({ paths: ['tests/setup/fixtures/example.md'] }).commands).toContain('tests')
    expect(selection({ paths: ['src/example/fixtures/input.md'] })).toMatchObject({
      commands: [
        'lint:fix',
        'typecheck',
        'eslint',
        'css',
        'build',
        'tests',
      ],
      checks: ['Lint, build and tests'],
      instructions: [
        'project',
        'review-code',
        'audit-tests',
        'deslop',
      ],
    })
    expect(selection({ paths: ['tests/setup/fixtures/example.md'] }).instructions).toEqual([
      'project',
      'review-code',
      'audit-tests',
      'deslop',
    ])
    expect(selection({ paths: ['skills/pnyx-cli/fixtures/input.md'] })).toMatchObject({
      commands: [
        'lint:fix',
        'typecheck',
        'eslint',
        'css',
        'build',
        'tests',
      ],
      checks: ['Lint, build and tests'],
      instructions: [
        'project',
        'review-code',
        'audit-tests',
        'deslop',
      ],
    })
    expect(selection({ paths: ['vitest.config.ts'] }).commands).toContain('tests')
    expect(selection({ paths: ['.github/workflows/tests.yml'] }).commands).toContain('tests')
    expect(selection({ paths: ['.github/workflows/tests.yml'] }).instructions).toContain('write-ci-workflow')
    expect(selection({
      paths: [
        'docs/testing.md',
        'src/app/server.ts',
      ],
    }).commands).toContain('tests')
  },
)

const workflow = parse(readFileSync(
  new URL(
    '../.github/workflows/docs-check.yml',
    import.meta.url,
  ),
  'utf8',
))
const scopeScript = workflow.jobs.scope.steps.find((step: { id?: string }) => step.id === 'scope').with.script
const scopeProgram = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { files, count, config, unavailable, changedHead, changedBase } = JSON.parse(input);
const result = { run: '', checks: [], requestedConfig: null };
let reads = 0;
const github = {
  rest: {
    pulls: {
      get: async () => {
        if (reads > 0 && unavailable === 'head') throw new Error('head unavailable');
        const reread = reads++ > 0;
        return { data: { changed_files: count, head: { sha: reread && changedHead ? 'new-head' : 'reviewed-head' }, base: { ref: reread && changedBase === 'ref' ? 'other' : 'main', sha: reread && changedBase === true ? 'new-base' : 'reviewed-base' } } };
      },
      listFiles: () => undefined
    },
    repos: {
      getContent: async ({ path, ref }) => {
        if (path !== 'deslop.config.json' || ref !== 'main') throw new Error('untrusted config request');
        if (unavailable === true) throw new Error('config unavailable');
        result.requestedConfig = { path, ref };
        return { data: { content: Buffer.from(JSON.stringify(config)).toString('base64') } };
      }
    },
    checks: { create: async check => result.checks.push(check) }
  },
  paginate: async () => files
};
const context = { repo: { owner: 'fixture', repo: 'pnyx' }, issue: { number: 1 }, payload: { repository: { default_branch: 'main' }, pull_request: { head: { sha: 'reviewed-head' } } } };
const core = { warning: () => undefined, setOutput: (name, value) => { result.run = value; } };
await (async () => { ${scopeScript} })();
console.log(JSON.stringify(result));
`

test.each([
  {
    name: 'empty file list',
    files: [],
    count: 0,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'ordinary docs',
    files: [
      { filename: 'docs/testing.md' },
      { filename: '.github/workflows/README.md' },
    ],
    count: 2,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'false',
    checks: [
      {
        owner: 'fixture',
        repo: 'pnyx',
        name: 'Lint, build and tests',
        head_sha: 'reviewed-head',
        status: 'completed',
        conclusion: 'success',
        output: {
          title: 'Documentation only',
          summary: 'No code checks selected by the default-branch policy.',
        },
      },
    ],
  },
  {
    name: 'source',
    files: [{ filename: 'src/app/server.ts' }],
    count: 1,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'shipped skills',
    files: [{ filename: 'skills/pnyx-cli/SKILL.md' }],
    count: 1,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'fixture Markdown',
    files: [{ filename: 'skills/pnyx-cli/fixtures/input.md' }],
    count: 1,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'code renamed into docs',
    files: [
      {
        filename: 'docs/new.md',
        previous_filename: 'src/old.ts',
      },
    ],
    count: 1,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'incomplete file list',
    files: [{ filename: 'docs/testing.md' }],
    count: 301,
    unavailable: false,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'unavailable config',
    files: [{ filename: 'docs/testing.md' }],
    count: 1,
    unavailable: true,
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'head recheck unavailable',
    files: [{ filename: 'docs/testing.md' }],
    count: 1,
    unavailable: 'head',
    changedHead: false,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
  {
    name: 'base branch changed at the same commit',
    files: [{ filename: 'docs/testing.md' }],
    count: 1,
    unavailable: false,
    changedHead: false,
    changedBase: 'ref',
    expected: 'true',
    checks: [],
  },
  {
    name: 'base moved while reading files',
    files: [{ filename: 'docs/testing.md' }],
    count: 1,
    unavailable: false,
    changedHead: false,
    changedBase: true,
    expected: 'true',
    checks: [],
  },
  {
    name: 'head moved while reading files',
    files: [{ filename: 'docs/testing.md' }],
    count: 1,
    unavailable: false,
    changedHead: true,
    changedBase: false,
    expected: 'true',
    checks: [],
  },
])(
  'CI scope handles $name without executing PR code',
  ({
    files,
    count,
    expected,
    checks,
    unavailable,
    changedHead,
    changedBase,
  }) => {
    const runnerTemp = mkdtempSync(join(
      process.env.TMPDIR!,
      'ci-scope-',
    ))
    temporaryFolders.push(runnerTemp)
    const modules = join(
      runnerTemp,
      'deslop-scope',
      'node_modules',
    )
    mkdirSync(
      modules,
      { recursive: true },
    )
    symlinkSync(
      fileURLToPath(new URL(
        '../node_modules/deslop',
        import.meta.url,
      )),
      join(
        modules,
        'deslop',
      ),
    )
    const config = JSON.parse(readFileSync(
      new URL(
        '../deslop.config.json',
        import.meta.url,
      ),
      'utf8',
    ))
    const result = JSON.parse(execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        scopeProgram,
      ],
      {
        input: JSON.stringify({
          files,
          count,
          config,
          unavailable,
          changedHead,
          changedBase,
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
        },
      },
    ))
    expect(result.run).toBe(expected)
    expect(result.checks).toEqual(checks)
  },
)

// A failed build must leave the last working dist, which every upgrade's rollback and every test run on it.
test(
  'a passing build replaces dist and leaves nothing beside it, and a failing build keeps the old dist',
  () => {
    const root = mkdtempSync(join(
      process.env.TMPDIR!,
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
