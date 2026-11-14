import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { stagedBuild } from '../scripts/build/staged.ts'
import { requiredChecks } from '../scripts/verification/required-checks.ts'

// CI's scope job decides from these paths whether the tests run at all, so a misread here ships untested code.
test(
  'a change runs the tests its paths call for: none for docs, the changed files for tests, the skill readers for skills and everything for code',
  () => {
    const scope = ({ paths }: { paths: string[] }) => requiredChecks({ paths }).tests

    expect(scope({ paths: ['docs/testing.md'] })).toBe('none')
    expect(scope({ paths: ['README.md'] })).toBe('none')
    expect(scope({ paths: ['tests/access.test.ts'] })).toBe('changed')
    expect(scope({ paths: ['skills/pnyx-cli/SKILL.md'] })).toBe('skills')
    expect(scope({ paths: ['src/app/server.ts'] })).toBe('full')
    expect(scope({ paths: ['web/src/hydra/hydra-chat.tsx'] })).toBe('full')
    // Setup and fixtures are not tests themselves, but every test file runs on them.
    expect(scope({ paths: ['tests/setup/pnyx.ts'] })).toBe('full')
    expect(scope({ paths: ['tests/setup/fixtures/gh-axi.mjs'] })).toBe('full')
    expect(scope({ paths: ['vitest.config.ts'] })).toBe('full')
    expect(scope({ paths: ['.github/workflows/tests.yml'] })).toBe('full')
    // Docs beside code never lower the scope, and no known paths means the full suite.
    expect(scope({
      paths: [
        'docs/testing.md',
        'src/app/server.ts',
      ],
    })).toBe('full')
    expect(scope({ paths: [] })).toBe('full')
    expect(requiredChecks({
      paths: [
        'tests/access.test.ts',
        'docs/testing.md',
      ],
    })).toMatchObject({
      tests: 'changed',
      changedTests: ['tests/access.test.ts'],
    })
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
