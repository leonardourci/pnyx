import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const cli = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

function sandbox() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-setup-home-',
  ))
  const home = join(
    root,
    '.pnyx',
  )
  const env = {
    ...process.env,
    HOME: root,
    PNYX_HOME: home,
    CLAUDE_CONFIG_DIR: join(
      home,
      '.claude',
    ),
    CODEX_HOME: join(
      home,
      '.codex',
    ),
    PNYX_SEMANTIC: 'off',
    PNYX_ACTOR: undefined,
  }
  mkdirSync(
    env.CLAUDE_CONFIG_DIR,
    { recursive: true },
  )
  mkdirSync(
    env.CODEX_HOME,
    { recursive: true },
  )

  return {
    root,
    home,
    env,
  }
}

for (const target of [
  'hooks',
  'service',
  'skills',
]) {
  test(
    `setup ${target} refuses custom homes before any user-wide change`,
    () => {
      const {
        root,
        home,
        env,
      } = sandbox()
      env.PNYX_HOME = join(
        home,
        'isolated',
      )

      for (const flags of [
        [],
        ['--preview'],
        ['--remove'],
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            'setup',
            target,
            ...flags,
          ],
          {
            env,
            encoding: 'utf8',
          },
        )
        assert.equal(
          result.status,
          1,
        )
        assert.match(
          result.stdout,
          /CUSTOM_HOME_SETUP/,
        )
        assert.match(
          result.stdout,
          /--allow-custom-home/,
        )
        assert.match(
          result.stdout,
          /Unset PNYX_HOME/,
        )
        assert.equal(
          existsSync(env.PNYX_HOME),
          false,
        )
        assert.equal(
          existsSync(join(
            env.CLAUDE_CONFIG_DIR,
            'settings.json',
          )),
          false,
        )
        assert.equal(
          existsSync(join(
            env.CODEX_HOME,
            'hooks.json',
          )),
          false,
        )
        assert.equal(
          existsSync(join(
            root,
            '.agents',
          )),
          false,
        )
        assert.equal(
          existsSync(join(
            root,
            'Library',
          )),
          false,
        )
      }
    },
  )

  test(
    `setup ${target} accepts the default home and the explicit custom-home override`,
    {
      skip: target === 'service' && process.platform !== 'darwin',
    },
    () => {
      const {
        home,
        env,
      } = sandbox()

      for (const custom of [
        false,
        true,
      ]) {
        if (custom) {
          env.PNYX_HOME = join(
            home,
            'isolated',
          )
        }

        const args = [
          cli,
          'setup',
          target,
          '--preview',
        ]

        if (custom) {
          args.push('--allow-custom-home')
        }

        const result = spawnSync(
          process.execPath,
          args,
          {
            env,
            encoding: 'utf8',
          },
        )
        assert.equal(
          result.status,
          0,
          result.stdout + result.stderr,
        )
        assert.doesNotMatch(
          result.stdout,
          /CUSTOM_HOME_SETUP/,
        )
      }
    },
  )
}

test(
  'an explicitly authorized custom home installs hooks for that home',
  () => {
    const {
      home,
      env,
    } = sandbox()
    env.PNYX_HOME = join(
      home,
      'isolated',
    )
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'setup',
        'hooks',
        '--allow-custom-home',
      ],
      {
        env,
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      0,
      result.stdout + result.stderr,
    )
    assert.equal(
      existsSync(join(
        env.PNYX_HOME,
        'hooks',
        'pnyx-hook.sh',
      )),
      true,
    )

    for (const path of [
      join(
        env.CLAUDE_CONFIG_DIR,
        'settings.json',
      ),
      join(
        env.CODEX_HOME,
        'hooks.json',
      ),
    ]) {
      assert.ok(readFileSync(
        path,
        'utf8',
      ).includes(join(
        env.PNYX_HOME,
        'hooks',
        'pnyx-hook.sh',
      )))
    }
  },
)

test(
  'the default home accepts an explicit path, a symlink and an unset PNYX_HOME',
  () => {
    const {
      root,
      home,
      env,
    } = sandbox()
    const alias = join(
      root,
      'alias',
    )
    symlinkSync(
      home,
      alias,
    )

    for (const path of [
      home,
      alias,
      '',
    ]) {
      env.PNYX_HOME = path
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'setup',
          'hooks',
          '--preview',
        ],
        {
          env,
          encoding: 'utf8',
        },
      )
      assert.equal(
        result.status,
        0,
        result.stdout + result.stderr,
      )
    }
  },
)
