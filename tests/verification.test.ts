import { expect, test } from 'vitest'
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
