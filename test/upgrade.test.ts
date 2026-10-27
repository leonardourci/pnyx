import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { runUpgrade, upgradeAvailable } from '../src/upgrade/runner.ts'
import { building, git, upgradeRepo } from './upgrade-fixture.ts'

const root = mkdtempSync(join(
  tmpdir(),
  'pnyx-upgrade-',
))
after(() => rmSync(
  root,
  {
    recursive: true,
    force: true,
  },
))

let repo: ReturnType<typeof upgradeRepo>

beforeEach(() => {
  repo = upgradeRepo({ root })
})

test(
  'an upgrade pulls, installs and builds origin main',
  async () => {
    const to = repo.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    const seen: string[] = []

    const result = await runUpgrade({
      root: repo.install,
      progress: ({ steps }) => seen.push(steps.map(step => `${step.step}:${step.state}`).join(' ')),
    })

    assert.equal(
      result.state,
      'upgraded',
    )
    assert.equal(
      result.to,
      to,
    )
    assert.equal(
      repo.head(),
      to,
    )
    assert.equal(
      repo.built(),
      'two',
    )
    assert.deepEqual(
      seen,
      [
        'pull:running',
        'pull:done',
        'pull:done install:running',
        'pull:done install:done',
        'pull:done install:done build:running',
        'pull:done install:done build:done',
      ],
    )
  },
)

test(
  'an upgrade with nothing new changes nothing',
  async () => {
    const before = repo.head()
    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'current',
    )
    assert.equal(
      repo.head(),
      before,
    )
  },
)

test(
  'a failed build goes back to the previous commit and its build',
  async () => {
    const from = repo.head()
    repo.publish({
      // Writes before failing, so only a rebuild of the old commit leaves 'one' behind.
      files: { 'build.sh': 'echo broken > built.txt\necho "src/card.tsx(4,7): error TS2322: Type string is not assignable" >&2\nexit 2\n' },
      message: 'broken build',
    })

    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'failed',
    )
    assert.equal(
      result.failed,
      'build',
    )
    assert.match(
      result.error!,
      /TS2322/,
    )
    assert.equal(
      result.from,
      from,
    )
    assert.equal(
      result.rolledBack,
      true,
    )
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      repo.built(),
      'one',
    )
    assert.equal(
      git({
        cwd: repo.install,
        args: [
          'status',
          '--porcelain',
        ],
      }),
      '',
    )
  },
)

test(
  'stopping a running build goes back to the previous commit and its build',
  async () => {
    const from = repo.head()
    repo.publish({
      // Writes, then hangs until stopped, so only a rebuild of the old commit leaves 'one' behind.
      files: { 'build.sh': 'echo two > built.txt\nexec sleep 30\n' },
      message: 'slow build',
    })
    const stopping = new AbortController()
    const started = Date.now()

    const result = await runUpgrade({
      root: repo.install,
      signal: stopping.signal,
      progress: ({ steps }) => {
        if (steps.at(-1)?.step === 'build' && steps.at(-1)?.state === 'running') {
          setTimeout(
            () => stopping.abort(),
            300,
          )
        }
      },
    })

    assert.equal(
      result.state,
      'stopped',
    )
    assert.deepEqual(
      result.steps.map(step => `${step.step}:${step.state}`),
      [
        'pull:done',
        'install:done',
        'build:stopped',
      ],
    )
    assert.equal(
      result.rolledBack,
      true,
    )
    assert.equal(
      result.error,
      undefined,
    )
    assert.ok(Date.now() - started < 10_000)
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      repo.built(),
      'one',
    )
    assert.equal(
      git({
        cwd: repo.install,
        args: [
          'status',
          '--porcelain',
        ],
      }),
      '',
    )
  },
)

test(
  'a failed install goes back before anything is built',
  async () => {
    const from = repo.head()
    repo.publish({
      files: {
        'install.sh': 'echo "ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/nope: Not Found" >&2\nexit 1\n',
        'build.sh': building({ version: 'two' }),
      },
      message: 'broken install',
    })

    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'failed',
    )
    assert.equal(
      result.failed,
      'install',
    )
    assert.match(
      result.error!,
      /ERR_PNPM_FETCH_404/,
    )
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      repo.built(),
      'one',
    )
  },
)

test(
  'a folder off main or with local changes is refused with every reason',
  async () => {
    const from = repo.head()
    repo.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    git({
      cwd: repo.install,
      args: [
        'checkout',
        '-b',
        'fix-cards',
      ],
    })

    for (const name of [
      'card.tsx',
      'host.ts',
      'index.css',
      'a.ts',
      'b.ts',
    ]) {
      writeFileSync(
        join(
          repo.install,
          name,
        ),
        'x\n',
      )
    }

    git({
      cwd: repo.install,
      args: [
        'add',
        '-A',
      ],
    })
    writeFileSync(
      join(
        repo.install,
        'build.sh',
      ),
      building({ version: 'local' }),
    )

    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'refused',
    )
    assert.deepEqual(
      result.reasons,
      [
        'On fix-cards, not main.',
        '6 files with local changes: a.ts, b.ts, build.sh and 3 more.',
      ],
    )
    assert.deepEqual(
      result.steps,
      [],
    )
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      readFileSync(
        join(
          repo.install,
          'build.sh',
        ),
        'utf8',
      ),
      building({ version: 'local' }),
    )
  },
)

test(
  'the daily check sees only a newer origin main',
  async () => {
    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      false,
    )

    git({
      cwd: repo.install,
      args: [
        'commit',
        '--allow-empty',
        '-m',
        'local only',
      ],
    })

    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      false,
    )

    repo.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })

    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      true,
    )

    git({
      cwd: repo.install,
      args: [
        'remote',
        'set-url',
        'origin',
        join(
          root,
          'missing.git',
        ),
      ],
    })

    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      undefined,
    )
  },
)
