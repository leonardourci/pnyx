import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { git, openPage, until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

async function installedProject({ s }: { s: Scenario }) {
  const path = await s.project({ name: 'application' })
  const source = join(
    import.meta.dirname,
    '..',
  )
  cpSync(
    join(
      source,
      'dist',
    ),
    join(
      path,
      'dist',
    ),
    { recursive: true },
  )
  cpSync(
    join(
      source,
      'skills',
    ),
    join(
      path,
      'skills',
    ),
    { recursive: true },
  )
  cpSync(
    join(
      source,
      'setup',
    ),
    join(
      path,
      'setup',
    ),
    { recursive: true },
  )
  symlinkSync(
    join(
      source,
      'node_modules',
    ),
    join(
      path,
      'node_modules',
    ),
    'dir',
  )
  writeFileSync(
    join(
      path,
      'package.json',
    ),
    JSON.stringify({
      type: 'module',
      imports: { '#*.ts': './dist/*.js' },
    }),
  )
  writeFileSync(
    join(
      path,
      '.gitignore',
    ),
    'dist/\nnode_modules\n',
  )
  git({
    cwd: path,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: path,
    args: [
      'commit',
      '-qm',
      'Install Pnyx',
    ],
  })
  git({
    cwd: path,
    args: [
      'push',
      '-q',
      'origin',
      'main',
    ],
  })

  return path
}

test(
  'a merged skill rename leaves the running install untouched and Hydra responding',
  async () => {
    const s = await pnyx.scenario()
    const path = await installedProject({ s })
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
      await pnyx.restart({ installRoot: alias })
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
          check: () => page.upgrades.at(-1)?.available === true,
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
    async t => {
      const s = await pnyx.scenario()
      const path = await installedProject({ s })
      const missing = join(
        path,
        'skills',
        name,
        'SKILL.md',
      )
      unlinkSync(missing)
      const errors = t.mock.method(
        console,
        'error',
      )

      try {
        await pnyx.restart({ installRoot: path })
        const agent = await s.chat({ text: 'Start without a shipped skill' })
        assert.ok(errors.mock.calls.some(call => String(call.arguments[0]).includes(missing)))
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
        await pnyx.restart()
      }
    },
  )
}
