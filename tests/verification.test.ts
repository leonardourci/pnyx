import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { parse } from 'yaml'
import { expect, test, vi } from 'vitest'
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
    expect(selection({ paths: ['src/example/fixtures/input.md'] })).toMatchObject({
      steps: [
        'lint:fix',
        'typecheck',
        'eslint',
        'css',
        'build',
        'tests',
      ],
      checks: ['Lint, build and tests'],
      skills: [
        'review-code',
        'audit-tests',
        'deslop',
      ],
    })
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

const markerHead = 'a'.repeat(40)
const passingMarker = {
  version: 1,
  head: markerHead,
  mode: 'ci',
  steps: {
    passed: true,
    names: ['Lint, build and tests'],
  },
  review: {
    clean: true,
    provider: 'codex',
    round: 1,
  },
  finishedAt: '2026-01-01T00:00:00Z',
}
const markerLine = ({ marker }: { marker: Record<string, unknown> }) => `<!-- verify:v1 ${JSON.stringify(marker)} -->`
const passingBody = markerLine({ marker: passingMarker })
const markerWorkflow = parse(readFileSync(
  new URL(
    '../.github/workflows/verify.yml',
    import.meta.url,
  ),
  'utf8',
))
const markerScript = new Script(`(async () => {${markerWorkflow.jobs.marker.steps[0].with.script}})()`)

test.each([
  {
    name: 'passed CI',
    body: passingBody,
    localRunCounts: false,
    accepted: true,
  },
  {
    name: 'accepted local fallback',
    body: markerLine({
      marker: {
        ...passingMarker,
        mode: 'local',
      },
    }),
    localRunCounts: true,
    accepted: true,
  },
  {
    name: 'refused local fallback',
    body: markerLine({
      marker: {
        ...passingMarker,
        mode: 'local',
      },
    }),
    localRunCounts: false,
    accepted: false,
  },
  {
    name: 'stale head',
    body: markerLine({
      marker: {
        ...passingMarker,
        head: 'b'.repeat(40),
      },
    }),
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'duplicate markers',
    body: `${passingBody}\n${passingBody}`,
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'missing marker',
    body: 'A pull request without verification',
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'malformed marker',
    body: '<!-- verify:v1 {invalid} -->',
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'failed checks',
    body: markerLine({
      marker: {
        ...passingMarker,
        steps: {
          passed: false,
          names: ['tests'],
        },
      },
    }),
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'unclean review',
    body: markerLine({
      marker: {
        ...passingMarker,
        review: {
          clean: false,
          provider: 'codex',
          round: 1,
        },
      },
    }),
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'missing review',
    body: markerLine({
      marker: {
        ...passingMarker,
        review: undefined,
      },
    }),
    localRunCounts: true,
    accepted: false,
  },
  {
    name: 'exhausted review rounds',
    body: markerLine({
      marker: {
        ...passingMarker,
        review: {
          clean: true,
          provider: 'codex',
          round: 4,
        },
      },
    }),
    localRunCounts: true,
    accepted: false,
  },
])(
  'the marker workflow handles $name',
  async ({
    body,
    localRunCounts,
    accepted,
  }) => {
    const failed = vi.fn()
    const getContent = vi.fn(async () => ({ data: { content: Buffer.from(JSON.stringify({ localRunCounts })).toString('base64') } }))
    await markerScript.runInNewContext({
      Buffer,
      github: {
        rest: {
          pulls: {
            get: async () => ({
              data: {
                body,
                head: { sha: markerHead },
              },
            }),
          },
          repos: { getContent },
        },
      },
      context: {
        repo: {
          owner: 'example',
          repo: 'project',
        },
        issue: { number: 1 },
        payload: { repository: { default_branch: 'main' } },
      },
      core: { setFailed: failed },
    })
    expect(failed.mock.calls.length === 0).toBe(accepted)
    expect(getContent).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'project',
      path: 'verify.config.json',
      ref: 'main',
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
