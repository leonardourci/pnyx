import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { git, logLines, openPage, scenarioGroup, until } from '#test-harness/harness.ts'

const HYDRA_RETRY_DELAY_MS = 600_000
const install = process.env.PNYX_TEST_INSTALL
assert.ok(
  install,
  'Run this flow through scripts/verification/test.ts with its disposable install',
)
assert.equal(
  realpathSync(join(
    import.meta.dirname,
    '..',
  )),
  realpathSync(install),
)

before(() => {
  git({
    cwd: install,
    args: [
      'init',
      '-q',
      '--bare',
      '-b',
      'main',
      `${install}.git`,
    ],
  })
  git({
    cwd: install,
    args: [
      'init',
      '-q',
      '-b',
      'main',
    ],
  })
  writeFileSync(
    join(
      install,
      '.gitignore',
    ),
    '*\n!skills/\n!skills/**\n!.gitignore\n',
  )
  git({
    cwd: install,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: install,
    args: [
      'commit',
      '-qm',
      'Install Pnyx',
    ],
  })
  git({
    cwd: install,
    args: [
      'remote',
      'add',
      'origin',
      `${install}.git`,
    ],
  })
  git({
    cwd: install,
    args: [
      'push',
      '-qu',
      'origin',
      'main',
    ],
  })
})

const pnyx = scenarioGroup({
  upgradeRoot: install,
  retryDelays: [HYDRA_RETRY_DELAY_MS],
})

test(
  'with the server stopped, pnyx-axi upgrade and upgrade --stop run in the terminal',
  async () => {
    const s = await pnyx.scenario()
    let upgraded = ''
    let stopped = ''

    await pnyx.restart({
      whileStopped: async () => {
        upgraded = await s.owner({ args: ['upgrade'] })
        stopped = await s.owner({
          args: [
            'upgrade',
            '--stop',
          ],
        })
      },
    })

    assert.match(
      upgraded,
      /result: "?none: Pnyx is already up to date/,
    )
    assert.match(
      stopped,
      /stopped: "?none: the Pnyx server is not pulling, installing, building or checking an upgrade/,
    )
    assert.equal(
      s.state().upgrades,
      undefined,
    )
  },
)

test(
  'a merged skill rename leaves the running install untouched and Hydra responding',
  async () => {
    const s = await pnyx.scenario()
    const path = install
    const alias = join(
      s.folder({ name: 'links' }),
      'application',
    )
    symlinkSync(
      path,
      alias,
      'dir',
    )
    await s.owner({
      args: [
        'project',
        'add',
        alias,
      ],
    })
    const publisher = s.folder({ name: 'publisher' })
    git({
      cwd: publisher,
      args: [
        'clone',
        '-q',
        `${path}.git`,
        '.',
      ],
    })
    renameSync(
      join(
        publisher,
        'skills/inscribe',
      ),
      join(
        publisher,
        'skills/renamed-inscribe',
      ),
    )
    git({
      cwd: publisher,
      args: [
        'add',
        '-A',
      ],
    })
    git({
      cwd: publisher,
      args: [
        'commit',
        '-qm',
        'Rename shipped skill',
      ],
    })
    git({
      cwd: publisher,
      args: [
        'push',
        '-q',
        'origin',
        'main',
      ],
    })
    const before = git({
      cwd: path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const target = git({
      cwd: publisher,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })

    try {
      await pnyx.restart()
      await s.chat({ text: 'Before the merge' })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'ship',
          '--title',
          'Ship skill rename',
          '--project',
          alias,
        ],
      })
      const url = s.pullRequest({
        number: 1,
        head: target,
        merge: target,
      })
      await s.owner({
        args: [
          'link',
          'ship',
          '--url',
          url,
        ],
      })
      s.pullRequest({
        number: 1,
        state: 'merged',
        head: target,
        merge: target,
      })
      const refreshed = await until({
        what: 'the merged project refresh to finish',
        check: () => s.task({ key: 'ship' }).projectRefresh?.[url],
      })

      assert.equal(
        refreshed.state,
        'needs-attention',
      )
      assert.match(
        refreshed.reason!,
        /running.*install.*\/upgrade/i,
      )
      assert.equal(
        git({
          cwd: path,
          args: [
            'rev-parse',
            'HEAD',
          ],
        }),
        before,
      )
      assert.equal(
        git({
          cwd: path,
          args: [
            'status',
            '--porcelain',
          ],
        }),
        '',
      )
      assert.equal(
        existsSync(join(
          path,
          'skills/inscribe/SKILL.md',
        )),
        true,
      )
      assert.equal(
        existsSync(join(
          path,
          'skills/renamed-inscribe',
        )),
        false,
      )
      const page = await openPage({
        port: pnyx.port(),
        hydraId: s.hydraId,
      })

      try {
        await until({
          what: 'the upgrade-available hint',
          check: () => page.upgrade()?.available === true,
        })
      } finally {
        page.close()
      }

      await s.chat({ text: 'After the merge' })
      assert.notEqual(
        s.state().hydraStatus?.state,
        'down',
      )
      assert.ok(s.state().cards[HYDRA_CARD]?.agent)
    } finally {
      await pnyx.restart()
    }
  },
)

for (const {
  name,
  expectedContract,
} of [
    {
      name: 'inscribe',
      expectedContract: /You are Hydra:/,
    },
    {
      name: 'pnyx-orchestrate',
      expectedContract: /run \/upgrade.*before taking on work/,
    },
  ]) {
  test(
    `a missing shipped ${name} skill is reported and Hydra still starts`,
    async () => {
      const s = await pnyx.scenario()
      const path = install
      const missing = join(
        path,
        'skills',
        name,
        'SKILL.md',
      )
      const original = readFileSync(
        missing,
        'utf8',
      )
      unlinkSync(missing)

      try {
        await pnyx.restart()
        const agent = await s.chat({ text: 'Start without a shipped skill' })
        assert.ok(logLines().some(record => record.level === 'warn' && record.operation === 'skills.missing' && record.name === name))
        assert.match(
          readFileSync(
            join(
              agent.cwd,
              'AGENTS.md',
            ),
            'utf8',
          ),
          expectedContract,
        )
        assert.equal(
          existsSync(join(
            agent.cwd,
            '.agents/skills',
            name,
            'SKILL.md',
          )),
          false,
        )
        assert.equal(
          readFileSync(
            join(
              agent.cwd,
              '.agents/skills/pnyx-set-up/SKILL.md',
            ),
            'utf8',
          ),
          readFileSync(
            join(
              path,
              'skills/pnyx-set-up/SKILL.md',
            ),
            'utf8',
          ),
        )
        assert.equal(
          s.state().cards[HYDRA_CARD]?.agent?.cwd,
          agent.cwd,
        )
        assert.notEqual(
          s.state().hydraStatus?.state,
          'down',
        )
        await s.chat({ text: 'Continue without that skill' })
      } finally {
        writeFileSync(
          missing,
          original,
        )
        await pnyx.restart()
      }
    },
  )
}
