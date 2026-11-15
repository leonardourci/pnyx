import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { stagedBuild } from '../scripts/build/staged.ts'
import { select, validateConfig } from 'verify/config'

test(
  'the shared verifier selects the Pnyx checks and review skills for each changed kind',
  () => {
    const config = validateConfig({
      root: fileURLToPath(new URL(
        '..',
        import.meta.url,
      )),
      config: JSON.parse(readFileSync(
        new URL(
          '../verify.config.json',
          import.meta.url,
        ),
        'utf8',
      )),
    })
    const selection = ({ paths }: { paths: string[] }) => select({
      config,
      paths,
    })

    expect(selection({ paths: ['docs/testing.md'] })).toMatchObject({
      steps: [],
      checks: [],
      skills: ['deslop'],
    })
    expect(selection({ paths: ['README.md'] })).toMatchObject({
      steps: [],
      checks: [],
    })
    expect(selection({ paths: ['skills/pnyx-cli/SKILL.md'] })).toMatchObject({
      steps: [
        'build',
        'integration',
      ],
      checks: ['Lint, build and tests'],
      skills: ['deslop'],
    })
    expect(selection({ paths: ['tests/access.test.ts'] }).steps).toContain('tests')
    expect(selection({ paths: ['web/src/hydra/hydra-chat.tsx'] }).skills).toContain('write-front-end')
    expect(selection({ paths: ['src/app/server.ts'] }).steps).toContain('tests')
    expect(selection({ paths: ['tests/setup/pnyx.ts'] }).steps).toContain('tests')
    expect(selection({ paths: ['tests/setup/fixtures/example.md'] }).steps).toContain('tests')
    expect(selection({ paths: ['tests/setup/fixtures/example.md'] }).skills).toEqual([
      'review-code',
      'audit-tests',
      'deslop',
    ])
    expect(selection({ paths: ['vitest.config.ts'] }).steps).toContain('tests')
    expect(selection({ paths: ['.github/workflows/tests.yml'] }).steps).toContain('tests')
    expect(selection({
      paths: [
        'docs/testing.md',
        'src/app/server.ts',
      ],
    }).steps).toContain('tests')
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
