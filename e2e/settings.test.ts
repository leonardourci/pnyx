import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'
import { effectiveDispatch, savedDocument } from '#workers/dispatch-config.ts'
import { readSettings } from '#settings/store.ts'
import { emptyHydra, replay } from '#app/reducer.ts'

test(
  'Hydra applies validated settings directly, records each change once in its chat, and keeps permission increases with the owner',
  async () => {
    const s = await pnyx.scenario()
    const other = await pnyx.scenario()
    const session = await s.chat({ text: 'Set the build rule effort to high.' })
    const hydra = s.as({ agent: session })
    const originalSettings = structuredClone(readSettings().settings)
    const originalDispatch = savedDocument()
    const settingsPage = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      await s.owner({
        args: [
          'rule',
          'set',
          'settings-build',
          '--harness',
          'claude',
          '--effort',
          'low',
        ],
      })
      const change = [
        'rule',
        'set',
        'settings-build',
        '--effort',
        'high',
        '--event-id',
        'build-effort',
      ]
      await hydra.run({ args: change })
      assert.equal(
        effectiveDispatch().dispatch.rules['settings-build']?.candidates[0]?.effort,
        'high',
      )
      assert.deepEqual(
        s.state().dispatchProposals ?? [],
        [],
      )
      const notices = () => s.state().hydraMessages?.filter(message => message.actor === 'pnyx'
        && message.text.startsWith('Changed ')) ?? []
      assert.equal(
        notices().length,
        1,
      )
      assert.match(
        notices()[0]!.text,
        /build.*effort.*high/,
      )
      assert.equal(
        notices()[0]!.hydra,
        s.state().config?.hydra.id,
      )
      await hydra.run({ args: change })
      assert.equal(
        notices().length,
        1,
      )
      assert.deepEqual(
        other.state().hydraMessages ?? [],
        [],
      )

      const invalid = [
        'rule',
        'set',
        'settings-build',
        '--effort',
        'bogus',
      ]
      assert.deepEqual(
        await hydra.refusal({ args: invalid }),
        await s.ownerRefusal({ args: invalid }),
      )
      assert.equal(
        effectiveDispatch().dispatch.rules['settings-build']?.candidates[0]?.effort,
        'high',
      )
      assert.equal(
        notices().length,
        1,
      )

      assert.equal(
        await hydra.refused({
          args: [
            'rule',
            'set',
            'settings-build',
            '--mode',
            'bypassPermissions',
          ],
        }),
        'OWNER_ONLY',
      )
      assert.equal(
        effectiveDispatch().dispatch.rules['settings-build']?.candidates[0]?.mode,
        undefined,
      )
      await s.owner({
        args: [
          'rule',
          'set',
          'settings-build',
          '--mode',
          'acceptEdits',
        ],
      })
      await hydra.run({
        args: [
          'rule',
          'set',
          'settings-build',
          '--mode',
          'default',
        ],
      })
      assert.equal(
        effectiveDispatch().dispatch.rules['settings-build']?.candidates[0]?.mode,
        'default',
      )
      assert.equal(
        notices().length,
        2,
      )

      await s.owner({
        args: [
          'hydra',
          'set',
          '--helper',
          'auto',
        ],
      })
      await hydra.run({
        args: [
          'hydra',
          'set',
          '--helper',
          'off',
        ],
      })
      assert.match(
        await s.owner({
          args: [
            'settings',
            'show',
          ],
        }),
        /helper: off/,
      )
      assert.equal(
        notices().length,
        3,
      )
      const settings = [
        'settings',
        'set',
        '--json',
        '{"fontSize":18}',
        '--event-id',
        'hydra-font',
      ]
      await hydra.run({ args: settings })
      await hydra.run({ args: settings })
      assert.match(
        await s.owner({
          args: [
            'settings',
            'show',
          ],
        }),
        /fontSize: 18/,
      )
      assert.equal(
        notices().length,
        4,
      )
      const invalidSettings = [
        'settings',
        'set',
        '--json',
        '{"fontSize":-1}',
      ]
      assert.deepEqual(
        await hydra.refusal({ args: invalidSettings }),
        await s.ownerRefusal({ args: invalidSettings }),
      )
      assert.equal(
        notices().length,
        4,
      )

      const account = 'claude:settings-test'
      await hydra.run({
        args: [
          'account',
          'set',
          account,
          '--provider',
          'claude',
          '--folder',
          s.folder({ name: 'login' }),
        ],
      })
      assert.equal(
        effectiveDispatch().accounts[account]?.provider,
        'claude',
      )
      assert.equal(
        notices().length,
        5,
      )
      await hydra.run({
        args: [
          'account',
          'remove',
          account,
        ],
      })
      assert.equal(
        effectiveDispatch().accounts[account],
        undefined,
      )
      assert.equal(
        notices().length,
        6,
      )

      const raised = await hydra.run({
        args: [
          'agent',
          '$hydra',
          'mode',
          'bypassPermissions',
        ],
      })
      assert.match(
        raised,
        /confirmation: needed/,
      )
      const proposal = s.state().dispatchProposals?.at(-1)
      assert.ok(proposal)
      assert.notEqual(
        s.state().cards.$hydra?.settings?.mode,
        'bypassPermissions',
      )
      assert.equal(
        await hydra.refused({
          args: [
            'approval',
            'confirm',
            proposal.token,
            '--confirm',
            proposal.token,
          ],
        }),
        'OWNER_ONLY',
      )
      await s.owner({
        args: [
          'approval',
          'dismiss',
          proposal.token,
        ],
      })
      await s.owner({
        args: [
          'agent',
          '$hydra',
          'mode',
          'bypassPermissions',
        ],
      })
      assert.match(
        await hydra.run({
          args: [
            'agent',
            '$hydra',
            'mode',
            'default',
          ],
        }),
        /now: default/,
      )
      await s.owner({
        args: [
          'agent',
          '$hydra',
          'mode',
          'bypassPermissions',
        ],
      })
      assert.equal(
        await hydra.refused({
          args: [
            'rule',
            'apply',
            '--json',
            '{"version":1,"patch":{"rules":{"settings-build":{"candidates":[{"harness":"claude","mode":"bypassPermissions"}]}}}}',
          ],
        }),
        'OWNER_ONLY',
      )
      await s.owner({
        args: [
          'agent',
          '$hydra',
          'mode',
          'default',
        ],
      })
      const workerFolder = s.folder({ name: 'worker' })
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Check permissions',
          '--key',
          'permissions',
          '--folder',
          workerFolder,
        ],
      })
      assert.equal(
        await hydra.refused({
          args: [
            'task',
            'start',
            'permissions',
            '--mode',
            'bypassPermissions',
            '--reason',
            'check permission guard',
          ],
        }),
        'OWNER_ONLY',
      )
      assert.equal(
        await hydra.refused({
          args: [
            'task',
            'start',
            'permissions',
            '--mode',
            'bypassPermissions',
            '--actor',
            'cli',
            '--reason',
            'check identity guard',
          ],
        }),
        'OWNER_ONLY',
      )
      assert.equal(
        s.task({ key: 'permissions' }).agent,
        undefined,
      )
      await s.owner({
        args: [
          'agent',
          '$hydra',
          'mode',
          'bypassPermissions',
        ],
      })
      await settingsPage.command({
        name: 'hydra-agent',
        args: ['{"harness":"claude","mode":"bypassPermissions"}'],
      })
      await until({
        what: 'the chosen bypass mode to reach Hydra',
        check: () => s.state().cards.$hydra?.settings?.mode === 'bypassPermissions',
      })
      const heardBeforeWorker = session.received.length
      const answeredBeforeWorker = session.answered
      await hydra.run({
        args: [
          'task',
          'start',
          'permissions',
          '--mode',
          'acceptEdits',
          '--reason',
          'lower inherited permissions',
        ],
      })
      assert.equal(
        s.task({ key: 'permissions' }).settings?.mode,
        'acceptEdits',
      )
      await until({
        what: 'Hydra to receive the task wake',
        check: () => session.received.slice(heardBeforeWorker).some(text => text.startsWith('<pnyx-wake>')),
      })
      await until({
        what: 'Hydra to finish the wake in its current permission mode',
        check: () => session.answered > answeredBeforeWorker,
      })
      assert.equal(
        s.state().cards.$hydra?.settings?.mode,
        'bypassPermissions',
      )
      await s.owner({
        args: [
          'rule',
          'set',
          'settings-build',
          '--mode',
          '',
        ],
      })
      await hydra.run({
        args: [
          'rule',
          'set',
          'settings-build',
          '--mode',
          'acceptEdits',
        ],
      })
      assert.equal(
        effectiveDispatch().dispatch.rules['settings-build']?.candidates[0]?.mode,
        'acceptEdits',
      )
      await settingsPage.command({
        name: 'hydra-agent',
        args: ['{"harness":"claude","mode":"default"}'],
      })
      await until({
        what: 'the chosen default mode to reach Hydra',
        check: () => s.state().cards.$hydra?.settings?.mode === 'default',
      })

      await until({
        what: 'the worker to finish its first turn',
        check: () => s.task({ key: 'permissions' }).sessionActivity === 'finished',
      })
      assert.match(
        await hydra.run({
          args: [
            'agent',
            'permissions',
            'mode',
            'bypassPermissions',
          ],
        }),
        /confirmation: needed/,
      )
      assert.notEqual(
        s.task({ key: 'permissions' }).settings?.mode,
        'bypassPermissions',
      )
      await s.owner({
        args: [
          'agent',
          'permissions',
          'mode',
          'acceptEdits',
        ],
      })
      assert.match(
        await hydra.run({
          args: [
            'agent',
            'permissions',
            'mode',
            'default',
          ],
        }),
        /now: default/,
      )
      assert.equal(
        s.task({ key: 'permissions' }).settings?.mode,
        'default',
      )
      assert.equal(
        notices().length,
        7,
      )
      await s.owner({
        args: [
          'hydra',
          'set',
          '--helper',
          'auto',
        ],
      })
      await hydra.run({
        args: [
          'hydra',
          'set',
          '--command',
          'true',
          '--helper',
          'off',
          '--event-id',
          'local-hydra-setting',
        ],
      })
      await hydra.run({
        args: [
          'hydra',
          'set',
          '--command',
          'true',
          '--helper',
          'off',
          '--event-id',
          'local-hydra-setting',
        ],
      })
      assert.equal(
        s.state().config?.command,
        'true',
      )
      assert.equal(
        notices().length,
        8,
      )
      const project = await s.project({ name: 'settings-project' })
      await hydra.run({
        args: [
          'project',
          'set',
          project,
          '--copy',
          'printf copy',
          '--event-id',
          'project-setting',
        ],
      })
      await hydra.run({
        args: [
          'project',
          'set',
          project,
          '--copy',
          'printf copy',
          '--event-id',
          'project-setting',
        ],
      })
      assert.equal(
        s.state().projects?.find(item => item.path === project)?.copy,
        'printf copy',
      )
      assert.equal(
        notices().length,
        9,
      )
      await s.owner({
        args: [
          'agent',
          'permissions',
          'mode',
          'bypassPermissions',
        ],
      })
      const elevatedSession = s.task({ key: 'permissions' }).sessionIds?.[0]
      assert.ok(elevatedSession)
      await s.owner({
        args: [
          'task',
          'detach',
          'permissions',
        ],
      })
      const ownSession = s.state().config?.hydra.session
      assert.equal(
        await hydra.refused({
          args: [
            'hydra',
            'set',
            '--session',
            elevatedSession,
          ],
        }),
        'OWNER_ONLY',
      )
      assert.equal(
        s.state().config?.hydra.session,
        ownSession,
      )
      assert.equal(
        notices().length,
        9,
      )
      const rebuilt = replay({
        state: emptyHydra(),
        events: s.events(),
      })
      assert.deepEqual(
        rebuilt.hydraMessages?.filter(message => message.text.startsWith('Changed ')),
        notices(),
      )

      await s.owner({
        args: [
          'rule',
          'set',
          'default',
          '--harness',
          'claude',
          '--mode',
          'bypassPermissions',
        ],
      })
      await s.owner({
        args: [
          'rule',
          'set',
          'hydra',
          '--candidates',
          '[{"harness":"claude","mode":"default"},{"harness":"codex","mode":"never"}]',
        ],
      })
      assert.equal(
        await hydra.refused({
          args: [
            'rule',
            'remove',
            'hydra',
          ],
        }),
        'OWNER_ONLY',
      )
      assert.equal(
        await hydra.refused({
          args: [
            'rule',
            'set',
            'hydra',
            '--candidates',
            '[{"harness":"codex","mode":"never"},{"harness":"claude","mode":"default"}]',
          ],
        }),
        'OWNER_ONLY',
      )
      assert.equal(
        effectiveDispatch().dispatch.rules.hydra?.candidates[0]?.mode,
        'default',
      )
    } finally {
      settingsPage.close()
      await s.owner({
        args: [
          'rule',
          'apply',
          '--json',
          JSON.stringify({
            version: 1,
            patch: {
              default: originalDispatch.default,
              rules: {
                hydra: originalDispatch.rules.hydra ?? null,
                'settings-build': originalDispatch.rules['settings-build'] ?? null,
              },
            },
          }),
        ],
      })
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify(originalSettings),
        ],
      })
    }
  },
)

test(
  'a setting changed from one Hydra reaches the open page of another, and its board layout stays its own',
  async () => {
    const first = await pnyx.scenario()
    const second = await pnyx.scenario()
    const before = await first.owner({
      args: [
        'settings',
        'show',
      ],
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: second.hydraId,
    })

    try {
      await until({
        what: 'the settings the page gets on connect',
        check: () => page.settings.length > 0,
      })
      await first.owner({
        args: [
          'view',
          'set',
          '--json',
          '{"theme":"dark","hydraWidth":600}',
        ],
      })
      await until({
        what: 'the dark theme pushed to the other Hydra\'s page',
        check: () => page.settings.at(-1)?.theme === 'dark',
      })
      await first.owner({
        args: [
          'view',
          'set',
          '--json',
          '{"keyboard":{"bindings":{"palette":["Mod+j"]}}}',
        ],
      })
      await until({
        what: 'the rebound Oracle shortcut pushed to the other Hydra\'s page',
        check: () => page.settings.at(-1)?.keyboard.bindings.palette?.[0] === 'Mod+j',
      })
      assert.match(
        await first.owner({
          args: [
            'view',
            'show',
          ],
        }),
        /hydraWidth: 600/,
      )

      await page.command({
        name: 'settings',
        args: [
          'set',
          '--json',
          '{"fontSize":17}',
        ],
      })
      assert.match(
        await first.owner({
          args: [
            'view',
            'show',
          ],
        }),
        /fontSize: 17/,
      )
    } finally {
      page.close()
      // Every flow shares one Pnyx home, so the values this flow found are put back.
      await first.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({
            theme: /theme: (\w+)/.exec(before)![1],
            fontSize: Number(/fontSize: (\d+)/.exec(before)![1]),
            keyboard: { bindings: { palette: null } },
          }),
        ],
      })
    }
  },
)
