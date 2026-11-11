import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { upgrade as upgradeCli } from './cli.ts'
import { runUpgrade, upgradeAvailable } from './runner.ts'
import { building, git, upgradeRepo } from '#test-harness/upgrade-fixture.ts'
import { killMidway } from '#test-harness/kill-midway.ts'

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

const REACHED_MS = 30_000

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

// Runs an upgrade in its own process and kills it once it wrote the given file, as a stopped session would.
const killedUpgrade = ({ reached }: { reached: string }) => killMidway({
  child: spawn(
    process.execPath,
    [
      '--conditions=source',
      '--input-type=module',
      '-e',
      `import { runUpgrade } from ${JSON.stringify(new URL(
        './runner.ts',
        import.meta.url,
      ).href)}\nawait runUpgrade({ root: ${JSON.stringify(repo.install)} })`,
    ],
    {
      detached: true,
      stdio: 'ignore',
    },
  ),
  reached,
  timeoutMs: REACHED_MS,
})

// Publishes a new commit and cuts the upgrade to it mid-build.
async function cutUpgrade() {
  const hold = join(
    repo.install,
    'hold',
  )
  const to = repo.publish({
    // Hangs while the hold file is there; like the real build, it writes nothing before it passes.
    files: { 'build.sh': 'if [ -f hold ]; then touch building; exec sleep 30; fi\necho two > built.txt\n' },
    message: 'two',
  })
  writeFileSync(
    hold,
    '',
  )
  await killedUpgrade({
    reached: join(
      repo.install,
      'building',
    ),
  })
  rmSync(hold)

  return to
}

test(
  'an upgrade whose caller was killed mid-build is finished by the next upgrade',
  async () => {
    const from = repo.head()
    const to = await cutUpgrade()

    assert.equal(
      repo.built(),
      'one',
    )
    assert.equal(
      repo.head(),
      to,
    )
    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      true,
    )

    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'upgraded',
    )
    assert.equal(
      result.from,
      from,
    )
    assert.equal(
      repo.built(),
      'two',
    )
    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      false,
    )
    assert.equal(
      (await runUpgrade({ root: repo.install })).state,
      'current',
    )
  },
)

test(
  'a failed step while finishing a cut upgrade goes back to the commit that upgrade began on',
  async () => {
    const from = repo.head()
    await cutUpgrade()
    // The pull fails, after the cut upgrade had already pulled.
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

    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'failed',
    )
    assert.equal(
      result.failed,
      'pull',
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
  },
)

test(
  'an upgrade killed during its fetch leaves nothing pending',
  async () => {
    const fetching = join(
      root,
      `fetching-${repo.head()}`,
    )
    const slowOrigin = `${fetching}.sh`
    writeFileSync(
      slowOrigin,
      `#!/bin/sh\ntouch ${fetching}\nexec sleep 30\n`,
      { mode: 0o755 },
    )
    git({
      cwd: repo.install,
      args: [
        'config',
        'remote.origin.uploadpack',
        slowOrigin,
      ],
    })
    await killedUpgrade({ reached: fetching })
    git({
      cwd: repo.install,
      args: [
        'config',
        '--unset',
        'remote.origin.uploadpack',
      ],
    })

    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      false,
    )
    assert.equal(
      (await runUpgrade({ root: repo.install })).state,
      'current',
    )
  },
)

test(
  'an upgrade that could not go back is still pending, and the next one starts from the same commit',
  async () => {
    const from = repo.head()
    repo.publish({
      // Edits a file the new commit added, which the reset back to the old commit refuses to discard.
      files: {
        'notes.txt': 'two\n',
        'build.sh': 'echo edited > notes.txt\necho "error TS2322" >&2\nexit 2\n',
      },
      message: 'broken build',
    })

    const failed = await runUpgrade({ root: repo.install })

    assert.equal(
      failed.state,
      'failed',
    )
    assert.equal(
      failed.rolledBack,
      false,
    )
    assert.equal(
      await upgradeAvailable({ root: repo.install }),
      true,
    )

    git({
      cwd: repo.install,
      args: [
        'checkout',
        'notes.txt',
      ],
    })
    repo.publish({
      files: { 'build.sh': building({ version: 'three' }) },
      message: 'three',
    })

    const result = await runUpgrade({ root: repo.install })

    assert.equal(
      result.state,
      'upgraded',
    )
    assert.equal(
      result.from,
      from,
    )
    assert.equal(
      repo.built(),
      'three',
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

test(
  'a worker cannot run pnyx-axi upgrade',
  async () => {
    process.env.PNYX_ACTOR = 'worker:ship'

    try {
      await assert.rejects(
        upgradeCli([]),
        { code: 'OWNER_ONLY' },
      )
    } finally {
      delete process.env.PNYX_ACTOR
    }
  },
)
