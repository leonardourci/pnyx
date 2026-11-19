import { readMemoryContext } from '#memory/context.ts'
import { beforeAll, expect, test } from 'vitest'
import { startReviewTimer } from '#hydra/review-timer.ts'
import { searchInBackground } from '#oracle/search-background.ts'
import { runForClient } from '#app/request-context.ts'
import { appendFileSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { startPnyx, pnyxAxi, parsed, until, type Pnyx } from './setup/pnyx.ts'
import { legacyDuplicate } from './setup/legacy.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'poleis enforce both locks and resolve every write from the Hydra',
  async () => {
    const work = await pnyx.hydra()
    const defaults = (await work.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra
    expect(defaults.polis).toBe('shared')
    expect(defaults.readPoleis).toEqual(['shared'])
    await work.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'work',
      ],
    })
    const changedHome = (await work.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra
    expect(changedHome.polis).toBe('work')
    expect(changedHome.readPoleis).toEqual(['shared'])
    const unavailableHome = await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(unavailableHome.writable ?? null).toBeNull()
    expect(unavailableHome.revision ?? null).toBeNull()
    expect((await work.ownerRefused({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Unavailable home',
      ],
    })).code).toBe('NOT_FOUND')
    await work.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'shared',
      ],
    })
    expect((await work.ownerRefused({
      args: [
        'hydra',
        'create',
        work.id,
        '--polis',
        'work',
        '--propose',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await work.ownerRefused({
      args: [
        'settings',
        'set',
        '--json',
        '{"poleis":{"shared":null}}',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await work.ownerRefused({
      args: [
        'hydra',
        'set',
        '--polis',
        '../outside',
      ],
    })).code).toBe('VALIDATION_ERROR')
    const personal = await pnyx.hydra()
    await work.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Shared quasar preference',
      ],
    })
    expect(JSON.stringify(await personal.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Shared quasar preference')
    await work.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            shared: { readers: ['*'] },
            work: { readers: [work.id] },
            personal: { readers: [personal.id] },
          },
        }),
      ],
    })
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work',
        '--polis',
        'work',
      ],
    })
    await personal.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'personal',
        '--polis',
        'personal',
      ],
    })
    await personal.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Secret nebula preference',
      ],
    })
    await work.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Work quasar learning',
        '--kind',
        'normal',
      ],
    })
    const crossEnv = {
      ...process.env,
      PNYX_ACTOR: 'hydra',
      PNYX_HYDRA: work.id,
      PNYX_TASK: undefined,
    }
    expect((await work.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'learnings',
        '--to',
        'shared',
        '--text',
        'Work quasar learning',
      ],
    })).code).toBe('VALIDATION_ERROR')
    await personal.owner({
      args: [
        'hydra',
        'memory',
        'set',
        '--key',
        'scope',
        '--text',
        'Private Hydra scope',
        '--reason',
        'Private Hydra scope',
      ],
    })
    const crossHydraRead = await pnyxAxi({
      args: [
        'hydra',
        'memory',
        'list',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(crossHydraRead.status).toBe(0)
    expect(crossHydraRead.stdout).not.toContain('Private Hydra scope')
    const historyArgs = [
      'history',
      '--kind',
      'hydra.memory',
      '--full',
      '--hydra',
      personal.id,
    ]
    const crossHydraHistory = await pnyxAxi({
      args: historyArgs,
      env: crossEnv,
    })
    expect(crossHydraHistory.status).toBe(0)
    expect(crossHydraHistory.stdout).not.toContain('Private Hydra scope')
    const nativeHistory = await pnyxAxi({
      args: historyArgs,
      env: {
        ...crossEnv,
        PNYX_HYDRA: personal.id,
      },
    })
    expect(nativeHistory.status).toBe(0)
    expect(nativeHistory.stdout).toContain('Private Hydra scope')
    expect(JSON.stringify(await personal.owner({
      args: [
        'oracle',
        'private',
      ],
    }))).toContain('[Private] Hydra scope')
    const crossHydraSearch = await pnyxAxi({
      args: [
        'oracle',
        'scope',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(crossHydraSearch.status).toBe(0)
    expect(crossHydraSearch.stdout).not.toContain('Private')
    const privateQuery = {
      text: 'private',
      limit: 10,
    }
    const ownerSearch = runForClient({
      identity: {},
      cwd: process.cwd(),
      run: () => searchInBackground({
        hydraId: personal.id,
        query: privateQuery,
      }),
    })
    const nativeSearch = runForClient({
      identity: {
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: work.id,
      },
      cwd: process.cwd(),
      run: () => searchInBackground({
        hydraId: personal.id,
        query: privateQuery,
      }),
    })
    const [
      ownerResult,
      nativeResult,
    ] = await Promise.all([
      ownerSearch,
      nativeSearch,
    ])
    expect(JSON.stringify(ownerResult.hits)).toContain('Private')
    expect(JSON.stringify(nativeResult.hits)).not.toContain('Private')

    const crossHydraWrite = await pnyxAxi({
      args: [
        'hydra',
        'memory',
        'forget',
        '--key',
        'scope',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(crossHydraWrite.status).not.toBe(0)
    expect(crossHydraWrite.stdout).toContain('NOT_FOUND')
    expect(JSON.stringify(await personal.owner({
      args: [
        'hydra',
        'memory',
        'list',
      ],
    }))).toContain('Private Hydra scope')
    await personal.owner({
      args: [
        'hydra',
        'memory',
        'forget',
        '--key',
        'scope',
      ],
    })
    expect(JSON.stringify(await personal.owner({
      args: [
        'oracle',
        'private',
      ],
    }))).not.toContain('[Private] Hydra scope')
    const crossRead = await pnyxAxi({
      args: [
        'owner',
        'memory',
        'list',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(crossRead.status).toBe(0)
    expect(crossRead.stdout).not.toContain('Secret nebula')
    const implicitOwnerRead = await pnyxAxi({
      args: [
        'owner',
        'memory',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(implicitOwnerRead.status).toBe(0)
    expect(parsed(implicitOwnerRead).memory).toBe('none: no owner memory yet')
    const crossOwnerWrite = await pnyxAxi({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Cross injected',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(crossOwnerWrite.status).not.toBe(0)
    expect(parsed(crossOwnerWrite).code).toBe('NOT_FOUND')
    expect((await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,personal',
        '--propose',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })).stdout).toContain('NOT_FOUND')
    expect((await pnyxAxi({
      args: [
        'oracle',
        'nebula',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })).stdout).not.toContain('Secret')
    expect(parsed(await pnyxAxi({
      args: [
        'hydra',
        'show',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })).hydra.readPoleis).toEqual([])
    const visible = JSON.stringify(await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))
    expect(visible).toContain('Shared quasar preference')
    expect(visible).toContain('Work quasar learning')
    expect(visible).not.toContain('Secret nebula')
    const workMemory = await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(JSON.stringify(workMemory.writable)).toContain('Work quasar learning')
    expect(JSON.stringify(workMemory.writable)).not.toContain('Shared quasar preference')
    expect(JSON.stringify(await personal.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).not.toContain('Shared quasar')
    expect(JSON.stringify(await work.owner({
      args: [
        'oracle',
        'nebula',
      ],
    }))).not.toContain('Secret nebula')
    expect(JSON.stringify(await personal.owner({
      args: [
        'oracle',
        'nebula',
      ],
    }))).toContain('Secret [nebula]')
    await personal.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Corrected supernova preference',
      ],
    })
    expect(JSON.stringify(await personal.owner({
      args: [
        'oracle',
        'nebula',
      ],
    }))).not.toContain('Secret [nebula]')
    expect(JSON.stringify(await personal.owner({
      args: [
        'oracle',
        'supernova',
      ],
    }))).toContain('Corrected [supernova] preference')
    await personal.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Private comet learning',
      ],
    })
    await personal.owner({
      args: [
        'owner',
        'memory',
        'confirm',
        '--text',
        'Private comet learning',
        '--reason',
        'test evidence',
      ],
    })
    await work.owner({
      args: [
        'owner',
        'memory',
        'save',
      ],
    })
    expect(JSON.stringify(await personal.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Private comet learning')
    await personal.owner({
      args: [
        'owner',
        'memory',
        'archive',
        '--text',
        'Private comet learning',
        '--reason',
        'test archive',
      ],
    })
    expect(JSON.stringify((await personal.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).memory)).not.toContain('Private comet learning')
    const shown = await pnyxAxi({
      args: [
        'settings',
        'show',
        '--hydra',
        work.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_TASK: undefined,
        PNYX_HYDRA: work.id,
      },
    })
    expect(shown.status).toBe(0)
    expect(shown.stdout).not.toContain('personal')
    const sharedSettingsEdit = await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--review-minutes',
        '0',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(sharedSettingsEdit.status).toBe(0)
    expect(sharedSettingsEdit.stdout).not.toContain('personal')
    const hiddenSpaceEdit = await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        '{"poleis":{"personal":null}}',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(hiddenSpaceEdit.status).not.toBe(0)
    expect(hiddenSpaceEdit.stdout).toContain('NOT_FOUND')
    const missingSpaceEdit = await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        '{"poleis":{"missing":null}}',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(missingSpaceEdit.stdout).toBe(hiddenSpaceEdit.stdout)
    const hiddenSpaceProposal = await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        '{"poleis":{"personal":null}}',
        '--propose',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(hiddenSpaceProposal.status).not.toBe(0)
    expect(hiddenSpaceProposal.stdout).toBe(hiddenSpaceEdit.stdout)
    expect(JSON.stringify(await personal.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Corrected supernova preference')
    const selfGrant = await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work,personal',
        '--hydra',
        work.id,
        '--reason',
        'test access policy',
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_TASK: undefined,
        PNYX_HYDRA: work.id,
      },
    })
    expect(selfGrant.status).not.toBe(0)
    expect(selfGrant.stdout + selfGrant.stderr).toContain('OWNER_ONLY')
    const hidden = await work.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'learnings',
        '--to',
        'personal',
      ],
    })
    const missing = await work.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'learnings',
        '--to',
        'missing',
      ],
    })
    expect(hidden).toEqual(missing)
    await work.owner({
      args: [
        'owner',
        'worker-notes',
        'set',
        '--text',
        'Work header quasar\n\n  Keep this indentation.\nwork header quasar',
        '--reason',
        'test work instructions',
      ],
    })
    await personal.owner({
      args: [
        'owner',
        'worker-notes',
        'set',
        '--text',
        'Secret header nebula',
        '--reason',
        'test private instructions',
      ],
    })
    const sharedNotes = await pnyx.hydra()
    await sharedNotes.owner({
      args: [
        'owner',
        'worker-notes',
        'set',
        '--text',
        'Shared header instructions',
        '--reason',
        'test shared instructions',
      ],
    })
    await personal.owner({
      args: [
        'hydra',
        'worker-notes',
        'set',
        '--text',
        'Private Hydra native notes',
        '--reason',
        'Test native prompt binding',
      ],
    })
    const nativeFolder = personal.folder({ name: 'native-bound-header' })
    await personal.owner({
      args: [
        'task',
        'create',
        '--title',
        'Native prompt binding',
        '--key',
        'native-bound-header',
        '--folder',
        nativeFolder,
        '--brief',
        'Test native prompt binding',
      ],
    })
    const nativeTask = await personal.task({ key: 'native-bound-header' })
    const nativeStart = await pnyxAxi({
      args: [
        'task',
        'start',
        nativeTask.id,
        '--hydra',
        personal.id,
        '--harness',
        'claude',
        '--reason',
        'Test native prompt binding',
      ],
      env: crossEnv,
    })
    expect(parsed(nativeStart)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'not found',
    })
    expect(pnyx.claude.sessions.some(session => session.cwd === nativeFolder)).toBe(false)
    await personal.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            personal: {
              readers: [
                personal.id,
                work.id,
              ],
            },
          },
        }),
      ],
    })
    const lockedStart = await pnyxAxi({
      args: [
        'task',
        'start',
        nativeTask.id,
        '--hydra',
        personal.id,
        '--harness',
        'claude',
        '--reason',
        'Test both capability locks',
      ],
      env: crossEnv,
    })
    expect(parsed(lockedStart)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'not found',
    })
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work,personal',
      ],
    })
    const sharedStart = await pnyxAxi({
      args: [
        'task',
        'start',
        nativeTask.id,
        '--hydra',
        personal.id,
        '--harness',
        'claude',
        '--reason',
        'Test admitted cross-Hydra worker',
      ],
      env: crossEnv,
    })
    expect(
      sharedStart.status,
      sharedStart.stdout + sharedStart.stderr,
    ).toBe(0)
    const nativeWorker = await personal.agent({ cwd: nativeFolder })
    await until({
      what: 'native prompt worker first turn',
      check: () => nativeWorker.answered === 1,
    })
    expect(nativeWorker.received.join('\n')).toContain('Native prompt binding')
    expect(nativeWorker.received.join('\n')).toContain('Private Hydra native notes')
    expect(nativeWorker.received.join('\n')).toContain('Secret header nebula')
    const boundRead = await pnyxAxi({
      args: [
        'owner',
        'memory',
        'list',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(boundRead.stdout).not.toContain('Secret header nebula')
    const boundWrite = await pnyxAxi({
      args: [
        'owner',
        'memory',
        'set',
        '--hydra',
        personal.id,
      ],
      env: crossEnv,
    })
    expect(parsed(boundWrite).code).toBe('NOT_FOUND')
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work',
      ],
    })
    await personal.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ poleis: { personal: { readers: [personal.id] } } }),
      ],
    })
    const ownFolder = personal.folder({ name: 'own-native-header' })
    await personal.owner({
      args: [
        'task',
        'create',
        '--title',
        'Own native prompt binding',
        '--key',
        'own-native-header',
        '--folder',
        ownFolder,
        '--brief',
        'Test own native prompt binding',
      ],
    })
    const ownStart = await pnyxAxi({
      args: [
        'task',
        'start',
        'own-native-header',
        '--hydra',
        personal.id,
        '--harness',
        'claude',
        '--reason',
        'Test own native prompt binding',
      ],
      env: {
        ...crossEnv,
        PNYX_HYDRA: personal.id,
      },
    })
    expect(
      ownStart.status,
      ownStart.stdout + ownStart.stderr,
    ).toBe(0)
    const ownWorker = await personal.agent({ cwd: ownFolder })
    await until({
      what: 'own native prompt worker first turn',
      check: () => ownWorker.answered === 1,
    })
    expect(ownWorker.received.join('\n')).toContain('Private Hydra native notes')
    expect(ownWorker.received.join('\n')).toContain('Secret header nebula')
    const { worker } = await work.startTask({ key: 'polis-header' })
    expect(worker.received.join('\n')).toContain('Shared header instructions\nWork header quasar\n\n  Keep this indentation.\nwork header quasar')
    expect(worker.received.join('\n')).not.toContain('Secret header nebula')
    const workerSettings = await pnyxAxi({
      args: [
        'settings',
        'show',
        '--hydra',
        work.id,
      ],
      env: worker.env,
    })
    expect(workerSettings.status).toBe(0)
    expect(workerSettings.stdout).not.toContain('personal')
    const workerConfig = await pnyxAxi({
      args: [
        'hydra',
        'show',
        '--hydra',
        personal.id,
      ],
      env: worker.env,
    })
    expect(workerConfig.status).toBe(0)
    expect(workerConfig.stdout).not.toContain('personal')
    const digest = (await pnyxAxi({
      args: [
        'hydra',
        'digest',
        '--hydra',
        work.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: undefined,
        PNYX_TASK: undefined,
        PNYX_HYDRA: undefined,
      },
    })).stdout
    expect(digest).toContain('Work quasar learning')
    expect(digest).not.toContain('Corrected supernova preference')
    await work.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'learnings',
        '--to',
        'shared',
      ],
    })
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'work',
      ],
    })
    expect(JSON.stringify(await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).not.toContain('Work quasar learning')
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work',
      ],
    })
    expect(JSON.stringify(await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Work quasar learning')
    await pnyx.restart()
    expect(JSON.stringify(await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Work quasar learning')
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work,personal',
        '--polis',
        'personal',
      ],
    })
    expect((await work.ownerRefused({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'forbidden',
      ],
    })).code).toBe('NOT_FOUND')
    expect(JSON.stringify(await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).not.toContain('Corrected supernova preference')
    await work.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,work',
        '--polis',
        'shared',
      ],
    })
    await work.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'x'.repeat(20_000),
      ],
    })
    await work.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'work',
      ],
    })
    await work.owner({
      args: [
        'owner',
        'worker-notes',
        'forget',
        '--reason',
        'test write-polis usage',
      ],
    })
    await work.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'small',
      ],
    })
    const roomyDigest = await pnyxAxi({
      args: [
        'hydra',
        'digest',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(roomyDigest.stdout).toContain('Owner memory uses 5 of 24000 characters.')
    expect(roomyDigest.stdout).not.toContain('curate it before it fills')
    await work.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'shared',
      ],
    })
    const nearlyFullDigest = await pnyxAxi({
      args: [
        'hydra',
        'digest',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(nearlyFullDigest.stdout).toContain('curate it before it fills')
  },
)

test(
  'project memory has one polis and requires attachment and both read locks',
  async () => {
    const allowed = await pnyx.hydra()
    const path = allowed.folder({ name: 'polis-project' })
    const privatePath = allowed.folder({ name: 'private/polis-project' })

    for (const project of [
      path,
      privatePath,
    ]) {
      await allowed.owner({
        args: [
          'project',
          'add',
          project,
        ],
      })
    }

    const hidden = await legacyDuplicate({
      pnyx,
      id: 'legacy-polis-hidden',
      projects: [{ path }],
    })
    const unattached = await legacyDuplicate({
      pnyx,
      id: 'legacy-polis-unattached',
      projects: [{ path: privatePath }],
    })
    await allowed.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            shared: { readers: ['*'] },
            'name-private': { readers: [unattached.id] },
            vault: { readers: [allowed.id] },
          },
        }),
      ],
    })
    await unattached.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,name-private',
      ],
    })
    await unattached.owner({
      args: [
        'project',
        'move',
        privatePath,
        '--polis',
        'name-private',
      ],
    })
    await allowed.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,vault',
      ],
    })
    await allowed.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        'Project pulsar learning',
        '--reason',
        'test project memory',
      ],
    })
    expect(JSON.stringify(await hidden.owner({
      args: [
        'project',
        'show',
        path,
      ],
    }))).toContain('Project pulsar learning')
    const initialProjectMemory = await allowed.owner({
      args: [
        'project',
        'show',
        path,
      ],
    })
    expect(JSON.stringify(initialProjectMemory)).toContain('Project pulsar learning')
    await allowed.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        'polis-project',
        '--key',
        'preferences',
        '--text',
        'Visible project selected by name',
        '--reason',
        'test hidden name collision',
      ],
    })
    expect((await allowed.ownerRefused({
      args: [
        'project',
        'memory',
        'confirm',
        '--project',
        path,
        '--text',
        'Project pulsar learning',
        '--if-revision',
        String(initialProjectMemory.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    await allowed.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Move learning to visible namesake',
        '--reason',
        'test hidden name collision',
      ],
    })
    await allowed.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        'polis-project',
        '--text',
        'Move learning to visible namesake',
        '--reason',
        'test hidden name collision',
      ],
    })
    await allowed.owner({
      args: [
        'project',
        'set',
        'polis-project',
        '--copy',
        'git clone --local',
      ],
    })
    expect(JSON.stringify(await allowed.owner({
      args: [
        'oracle',
        'pulsar',
        '--project',
        'polis-project',
      ],
    }))).toContain('Project [pulsar]')

    expect(JSON.stringify(await allowed.owner({
      args: [
        'project',
        'show',
        path,
      ],
    }))).toContain('Visible project selected by name')

    expect((await unattached.ownerRefused({
      args: [
        'project',
        'show',
        path,
      ],
    })).code).toBe('NOT_FOUND')
    const searchableBeforeMove = await hidden.owner({
      args: [
        'oracle',
        'pulsar',
      ],
    })
    expect(JSON.stringify(searchableBeforeMove)).toContain('Project [pulsar]')
    await hidden.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,vault',
      ],
    })
    await allowed.owner({
      args: [
        'project',
        'move',
        'polis-project',
        '--polis',
        'vault',
      ],
    })
    expect(JSON.stringify(await hidden.owner({
      args: [
        'project',
        'list',
      ],
    }))).toContain('polis-project')
    expect((await pnyxAxi({
      args: [
        'project',
        'show',
        path,
        '--hydra',
        allowed.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: hidden.id,
        PNYX_TASK: undefined,
      },
    })).stdout).toContain('NOT_FOUND')
    expect(JSON.stringify(await hidden.owner({
      args: [
        'project',
        'show',
        path,
      ],
    }))).not.toContain('Project pulsar learning')
    expect((await hidden.ownerRefused({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        'blocked',
        '--reason',
        'test',
      ],
    })).code).toBe('NOT_FOUND')
    expect((await pnyxAxi({
      args: [
        'hydra',
        'digest',
        '--hydra',
        hidden.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: undefined,
        PNYX_TASK: undefined,
        PNYX_HYDRA: undefined,
      },
    })).stdout).not.toContain('polis-project')
    expect(JSON.stringify(await hidden.owner({
      args: [
        'oracle',
        'pulsar',
      ],
    }))).not.toContain('Project [pulsar]')
    // The owner settles the legacy duplicate, so the project can later be attached to its keeper again.
    await allowed.owner({
      args: [
        'project',
        'keep',
        path,
      ],
    })
    const noProjectHit = await allowed.owner({
      args: [
        'oracle',
        'Hydra',
        '--project',
        path,
      ],
    })
    expect(Array.isArray(noProjectHit.results)).toBe(false)
    const projectHit = await allowed.owner({
      args: [
        'oracle',
        'pulsar',
        '--project',
        path,
      ],
    })
    expect(JSON.stringify(projectHit)).toContain('Project [pulsar]')
    expect(JSON.stringify(await allowed.owner({
      args: [
        'oracle',
        'pulsar',
      ],
    }))).toContain('[pulsar]')
    await allowed.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'preferences',
        '--text',
        'Write project while owner write polis remains shared',
        '--reason',
        'test project write exception',
      ],
    })
    expect(JSON.stringify(await allowed.owner({
      args: [
        'project',
        'show',
        path,
      ],
    }))).toContain('Write project while')
    await allowed.owner({
      args: [
        'project',
        'memory',
        'forget',
        '--project',
        path,
        '--key',
        'learnings',
        '--reason',
        'Pulsar learning is obsolete',
      ],
    })
    expect(JSON.stringify(await allowed.owner({
      args: [
        'oracle',
        'pulsar',
        '--project',
        path,
      ],
    }))).not.toContain('Project [pulsar]')
    await allowed.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Learning stays after project detach',
      ],
    })
    await allowed.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        'Confirm this original learning',
      ],
    })
    const gateBin = allowed.folder({ name: 'git-gate' })
    const git = join(
      gateBin,
      'git',
    )
    copyFileSync(
      new URL(
        './setup/fixtures/memory/git-read-gate.mjs',
        import.meta.url,
      ),
      git,
    )
    chmodSync(
      git,
      0o755,
    )
    const sockets: Socket[] = []
    let released = false
    let blockedReads = 2
    const gate = createServer(socket => {
      sockets.push(socket)

      if (released || sockets.length === 1 || sockets.length > blockedReads) {
        socket.end()
      }
    })
    const socketPath = join(
      gateBin,
      'gate.sock',
    )
    await new Promise<void>(resolve => gate.listen(
      socketPath,
      resolve,
    ))
    const previousPath = process.env.PATH
    process.env.PATH = `${gateBin}:${previousPath}`
    process.env.PNYX_TEST_GIT_PROJECT = path
    process.env.PNYX_TEST_GIT_SOCKET = socketPath

    try {
      const confirming = allowed.ownerRefused({
        args: [
          'project',
          'memory',
          'confirm',
          '--project',
          path,
          '--text',
          'Confirm this original learning',
          '--reason',
          'Rechecked project learning',
        ],
      })
      await until({
        what: 'confirmation write Git read is gated',
        check: () => sockets.length >= blockedReads,
      })
      await allowed.owner({
        args: [
          'project',
          'memory',
          'set',
          '--project',
          path,
          '--key',
          'learnings',
          '--text',
          'Confirm this original learning\nEdited while confirmation waited',
        ],
      })
      released = true
      sockets.forEach(socket => socket.end())
      expect((await confirming).code).toBe('REVISION_CONFLICT')
      expect(JSON.stringify(await allowed.owner({
        args: [
          'project',
          'show',
          path,
        ],
      }))).toContain('Edited while confirmation waited')
      released = false
      blockedReads = sockets.length + 2
      const moving = allowed.ownerRefused({
        args: [
          'owner',
          'memory',
          'move',
          '--project',
          path,
          '--text',
          'Learning stays after project detach',
          '--reason',
          'Test detached project memory',
        ],
      })
      const writing = allowed.ownerRefused({
        args: [
          'project',
          'memory',
          'set',
          '--project',
          path,
          '--key',
          'preferences',
          '--text',
          'Detached write must not persist',
        ],
      })
      const pending = Promise.all([
        moving,
        writing,
      ])
      await until({
        what: 'both Git reads are gated',
        check: () => sockets.length === blockedReads,
      })
      await allowed.owner({
        args: [
          'project',
          'remove',
          path,
        ],
      })
      sockets.forEach(socket => socket.end())
      const [
        moved,
        written,
      ] = await pending
      expect(moved.code).toBe('NOT_FOUND')
      expect(written.code).toBe('NOT_FOUND')
      released = true
      const ownerMemory = await allowed.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(ownerMemory.writable.learnings.text).toBe('Learning stays after project detach')
      await allowed.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
      expect(JSON.stringify(await allowed.owner({
        args: [
          'project',
          'show',
          path,
        ],
      }))).not.toContain('Detached write must not persist')
      released = false
      blockedReads = sockets.length + 1
      process.env.PNYX_TEST_GIT_ARG = 'remote'
      const detachListing = allowed.owner({
        args: [
          'project',
          'list',
        ],
      })
      await until({
        what: 'attachment list Git read is gated',
        check: () => sockets.length >= blockedReads,
      })
      await allowed.owner({
        args: [
          'project',
          'remove',
          path,
        ],
      })
      released = true
      sockets.forEach(socket => socket.end())
      const detachedList = await detachListing
      expect(detachedList.projects).toContainEqual(expect.objectContaining({
        path,
        state: 'detached',
      }))
      const currentList = await allowed.owner({
        args: [
          'project',
          'list',
        ],
      })
      expect(detachedList.revision).toBe(currentList.revision)
      await allowed.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
      released = false
      blockedReads = sockets.length + 1
      const listing = allowed.owner({
        args: [
          'project',
          'list',
        ],
      })
      await until({
        what: 'project list Git read is gated',
        check: () => sockets.length >= blockedReads,
      })
      await allowed.owner({
        args: [
          'hydra',
          'set',
          '--read-poleis',
          'shared',
        ],
      })
      released = true
      sockets.forEach(socket => socket.end())
      expect(JSON.stringify(await listing)).toContain(path)

      released = false
      blockedReads = sockets.length + 1
      const showing = allowed.owner({
        args: [
          'hydra',
          'show',
        ],
      })
      await until({
        what: 'Hydra show Git read is gated',
        check: () => sockets.length >= blockedReads,
      })
      await allowed.owner({
        args: [
          'hydra',
          'set',
          '--polis',
          'vault',
          '--read-poleis',
          'shared,vault',
        ],
      })
      released = true
      sockets.forEach(socket => socket.end())
      const shown = await showing
      expect(shown.hydra.polis).toBe('vault')
      expect(shown.projects).toContainEqual(expect.objectContaining({ path }))

      delete process.env.PNYX_TEST_GIT_ARG
      await allowed.owner({
        args: [
          'hydra',
          'set',
          '--polis',
          'shared',
        ],
      })
      released = false
      const previousReads = sockets.length
      blockedReads = previousReads + 1
      const digest = pnyxAxi({
        args: [
          'hydra',
          'digest',
          '--hydra',
          allowed.id,
        ],
        env: {
          ...process.env,
          PNYX_ACTOR: undefined,
          PNYX_TASK: undefined,
          PNYX_HYDRA: undefined,
        },
      })
      await until({
        what: 'digest Git read is gated',
        check: () => sockets.length > previousReads,
      })
      await allowed.owner({
        args: [
          'project',
          'remove',
          path,
        ],
      })
      released = true
      sockets.forEach(socket => socket.end())
      const digested = await digest
      expect(
        digested.status,
        digested.stdout + digested.stderr,
      ).toBe(0)
      expect(digested.stdout).not.toContain('polis-project')

      await allowed.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
      await allowed.owner({
        args: [
          'project',
          'memory',
          'set',
          '--project',
          path,
          '--key',
          'learnings',
          '--text',
          'Revoked project review learning',
          '--kind',
          'for-now',
          '--until',
          'date:2000-01-01',
        ],
      })
      await allowed.owner({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'learnings',
          '--text',
          'Owner review anchor',
          '--kind',
          'for-now',
          '--until',
          'date:2000-01-01',
        ],
      })
      const previousReviewMinutes = (await allowed.owner({
        args: [
          'settings',
          'show',
        ],
      })).settings.reviewMinutes
      await allowed.owner({
        args: [
          'settings',
          'set',
          '--json',
          '{"reviewMinutes":1}',
        ],
      })
      let reviewNow = Date.parse('2099-01-01T00:00:00Z')
      const timer = startReviewTimer({
        hydraId: allowed.id,
        now: () => reviewNow,
        wake: () => {},
        interval: () => () => {},
      })

      try {
        reviewNow = Date.parse('2099-01-01T00:01:00Z')
        await timer.check()
        const beforeDetach = await allowed.owner({
          args: [
            'history',
            '--kind',
            'hydra.review',
            '--full',
            '--limit',
            '1',
          ],
        })
        expect(beforeDetach.events[0].data.block).toContain('Revoked project review learning')
        expect(beforeDetach.events[0].data.block).toContain('Owner review anchor')
        const readableReview = await pnyxAxi({
          args: [
            'history',
            '--kind',
            'hydra.review',
            '--full',
            '--hydra',
            allowed.id,
          ],
          env: {
            ...process.env,
            PNYX_ACTOR: 'hydra',
            PNYX_HYDRA: allowed.id,
            PNYX_TASK: undefined,
          },
        })
        expect(readableReview.status).toBe(0)
        expect(readableReview.stdout).toContain('Revoked project review learning')

        released = false
        blockedReads = sockets.length + 1
        process.env.PNYX_TEST_GIT_ARG = '--show-toplevel'
        const unstableHistory = pnyxAxi({
          args: [
            'history',
            '--kind',
            'hydra.review',
            '--full',
            '--hydra',
            allowed.id,
          ],
          env: {
            ...process.env,
            PNYX_ACTOR: 'hydra',
            PNYX_HYDRA: allowed.id,
            PNYX_TASK: undefined,
          },
        })

        for (const reads of [
          'shared',
          'shared,vault',
          'shared',
        ]) {
          await until({
            what: 'history visibility Git read is gated',
            check: () => sockets.length >= blockedReads,
          })
          const socket = sockets.at(-1)!
          blockedReads++
          await allowed.owner({
            args: [
              'hydra',
              'set',
              '--read-poleis',
              reads,
            ],
          })
          socket.end()
        }

        released = true
        delete process.env.PNYX_TEST_GIT_ARG
        const unstableResult = await unstableHistory
        expect(unstableResult.status).toBe(1)
        expect(parsed(unstableResult).code).toBe('CONFLICT')
        await allowed.owner({
          args: [
            'hydra',
            'set',
            '--read-poleis',
            'shared,vault',
          ],
        })

        expect(JSON.stringify(await allowed.owner({
          args: [
            'oracle',
            'revoked',
          ],
        }))).toContain('[Revoked]')
        released = false
        const reviewReads = sockets.length
        blockedReads = reviewReads + 1
        reviewNow = Date.parse('2099-01-01T00:02:00Z')
        const reviewing = timer.check()
        await until({
          what: 'timed review Git read is gated',
          check: () => sockets.length > reviewReads,
        })
        await allowed.owner({
          args: [
            'project',
            'remove',
            path,
          ],
        })
        released = true
        sockets.forEach(socket => socket.end())
        await reviewing
        const afterDetach = await allowed.owner({
          args: [
            'history',
            '--kind',
            'hydra.review',
            '--full',
            '--limit',
            '1',
          ],
        })
        expect(afterDetach.events[0].at).toBe('2099-01-01T00:02:00.000Z')
        expect(afterDetach.events[0].data.block).toContain('Owner review anchor')
        expect(afterDetach.events[0].data.block).not.toContain('Revoked project review learning')
        expect(afterDetach.events[0].data.block).not.toContain('polis-project')
        const agentHistory = await pnyxAxi({
          args: [
            'history',
            '--kind',
            'hydra.review',
            '--full',
            '--hydra',
            allowed.id,
          ],
          env: {
            ...process.env,
            PNYX_ACTOR: 'hydra',
            PNYX_HYDRA: allowed.id,
            PNYX_TASK: undefined,
          },
        })
        expect(agentHistory.status).toBe(0)
        expect(agentHistory.stdout).not.toContain('Revoked project review learning')
        expect(JSON.stringify(await allowed.owner({
          args: [
            'history',
            '--kind',
            'hydra.review',
            '--full',
          ],
        }))).toContain('Revoked project review learning')

        expect(JSON.stringify(await allowed.owner({
          args: [
            'oracle',
            'revoked',
          ],
        }))).not.toContain('[Revoked]')
      } finally {
        timer.close()
        await allowed.owner({
          args: [
            'settings',
            'set',
            '--json',
            JSON.stringify({ reviewMinutes: previousReviewMinutes }),
          ],
        })
      }
    } finally {
      process.env.PATH = previousPath
      delete process.env.PNYX_TEST_GIT_PROJECT
      delete process.env.PNYX_TEST_GIT_ARG
      delete process.env.PNYX_TEST_GIT_SOCKET
      sockets.forEach(socket => socket.destroy())
      await new Promise<void>(resolve => gate.close(() => resolve()))
    }
  },
)

test(
  'Hydra proposes wider polis access for Confirm and narrows directly',
  async () => {
    const hydra = await pnyx.hydra()
    const project = hydra.folder({ name: 'permission-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    const other = await legacyDuplicate({
      pnyx,
      id: 'legacy-permission-other',
      projects: [{ path: project }],
    })
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            controlled: { readers: [hydra.id] },
            extra: { readers: [hydra.id] },
          },
        }),
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,controlled',
      ],
    })
    await hydra.chat({ text: 'Memory permission test' })
    await hydra.owner({
      args: [
        'agent',
        '$hydra',
        'mode',
        'bypassPermissions',
      ],
    })
    const env = {
      ...process.env,
      PNYX_ACTOR: 'hydra',
      PNYX_HYDRA: hydra.id,
      PNYX_TASK: undefined,
    }
    const concurrent = await Promise.all([
      pnyxAxi({
        args: [
          'hydra',
          'set',
          '--read-poleis',
          'shared',
          '--reason',
          'Narrow memory access',
          '--hydra',
          hydra.id,
        ],
        env,
      }),
      pnyxAxi({
        args: [
          'hydra',
          'set',
          '--polis',
          'controlled',
          '--reason',
          'Select memory home',
          '--hydra',
          hydra.id,
        ],
        env,
      }),
    ])
    expect(concurrent.map(result => result.status)).toEqual([
      0,
      0,
    ])
    const serialized = (await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra
    expect(serialized.readPoleis).toEqual(['shared'])
    expect(serialized.polis).toBe('controlled')
    expect((await hydra.ownerRefused({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Unreadable home',
      ],
    })).code).toBe('NOT_FOUND')
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'shared',
        '--read-poleis',
        'shared,controlled',
      ],
    })

    const widerReads = [
      'hydra',
      'set',
      '--read-poleis',
      'shared,controlled,extra',
      '--review-minutes',
      '25',
      '--hydra',
      hydra.id,
    ]
    const refusedReads = await pnyxAxi({
      args: widerReads,
      env,
    })
    expect(refusedReads.status).not.toBe(0)
    expect(refusedReads.stdout).toContain('OWNER_ONLY')
    const proposedReads = parsed(await pnyxAxi({
      args: [
        ...widerReads,
        '--propose',
      ],
      env,
    }))
    expect(proposedReads.confirmation).toBe('needed')
    expect((await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.readPoleis).toEqual([
      'shared',
      'controlled',
    ])
    await hydra.owner({
      args: [
        'approval',
        'confirm',
        proposedReads.token,
        '--confirm',
        proposedReads.token,
      ],
    })
    expect((await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.readPoleis).toEqual([
      'shared',
      'controlled',
      'extra',
    ])
    expect((await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,controlled',
        '--hydra',
        hydra.id,
      ],
      env,
    })).status).toBe(0)

    const widerReaders = [
      'settings',
      'set',
      '--json',
      JSON.stringify({
        poleis: {
          controlled: {
            readers: [
              hydra.id,
              other.id,
            ],
          },
        },
      }),
      '--hydra',
      hydra.id,
    ]
    expect((await pnyxAxi({
      args: widerReaders,
      env,
    })).stdout).toContain('OWNER_ONLY')
    let proposedReaders = parsed(await pnyxAxi({
      args: [
        ...widerReaders,
        '--propose',
      ],
      env,
    }))
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.controlled.readers).toEqual([hydra.id])
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logDays":23}',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposedReaders.token,
        '--confirm',
        proposedReaders.token,
      ],
    })).code).toBe('CONFLICT')
    await hydra.owner({
      args: [
        'approval',
        'dismiss',
        proposedReaders.token,
      ],
    })
    proposedReaders = parsed(await pnyxAxi({
      args: [
        ...widerReaders,
        '--propose',
      ],
      env,
    }))
    await hydra.owner({
      args: [
        'approval',
        'confirm',
        proposedReaders.token,
        '--confirm',
        proposedReaders.token,
      ],
    })
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.controlled.readers).toEqual([
      hydra.id,
      other.id,
    ])
    expect((await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ poleis: { controlled: { readers: [hydra.id] } } }),
        '--hydra',
        hydra.id,
      ],
      env,
    })).status).toBe(0)
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.controlled.readers).toEqual([hydra.id])

    expect((await pnyxAxi({
      args: [
        'project',
        'move',
        project,
        '--polis',
        'controlled',
        '--hydra',
        hydra.id,
      ],
      env,
    })).status).toBe(0)
    expect(JSON.stringify(await other.owner({
      args: [
        'project',
        'list',
      ],
    }))).toContain('permission-project')
    expect((await pnyxAxi({
      args: [
        'project',
        'move',
        project,
        '--polis',
        'shared',
        '--hydra',
        hydra.id,
      ],
      env,
    })).stdout).toContain('OWNER_ONLY')
    const projectProposalArgs = [
      'project',
      '--polis',
      'shared',
      'move',
      project,
      '--propose',
      '--hydra',
      hydra.id,
    ]
    let projectProposal = parsed(await pnyxAxi({
      args: projectProposalArgs,
      env,
    }))
    expect(JSON.stringify(await other.owner({
      args: [
        'project',
        'list',
      ],
    }))).toContain('permission-project')
    await other.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        '',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'approval',
        'confirm',
        projectProposal.token,
        '--confirm',
        projectProposal.token,
      ],
    })).code).toBe('CONFLICT')
    await hydra.owner({
      args: [
        'approval',
        'dismiss',
        projectProposal.token,
      ],
    })
    await other.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared',
      ],
    })
    projectProposal = parsed(await pnyxAxi({
      args: projectProposalArgs,
      env,
    }))
    await hydra.owner({
      args: [
        'approval',
        'confirm',
        projectProposal.token,
        '--confirm',
        projectProposal.token,
      ],
    })
    expect(JSON.stringify(await other.owner({
      args: [
        'project',
        'list',
      ],
    }))).toContain('permission-project')

    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'controlled',
      ],
    })
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Controlled magnetar note',
      ],
    })
    const move = [
      'owner',
      'memory',
      'move',
      '--key',
      'preferences',
      '--to',
      'shared',
      '--hydra',
      hydra.id,
    ]
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            shared: {
              readers: [
                hydra.id,
                'future-polis-reader',
              ],
            },
          },
        }),
      ],
    })
    expect((await pnyxAxi({
      args: move,
      env,
    })).stdout).toContain('OWNER_ONLY')
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"poleis":{"shared":{"readers":["*"]}}}',
      ],
    })
    const sourceMemory = await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'forget',
        '--key',
        'preferences',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'preferences',
        '--to',
        'shared',
        '--if-revision',
        String(sourceMemory.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Controlled magnetar note',
      ],
    })
    expect((await pnyxAxi({
      args: move,
      env,
    })).stdout).toContain('OWNER_ONLY')
    let moveProposal = parsed(await pnyxAxi({
      args: [
        ...move,
        '--propose',
      ],
      env,
    }))
    expect(JSON.stringify(await other.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).not.toContain('Controlled magnetar note')
    await other.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Latest destination preference',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'approval',
        'confirm',
        moveProposal.token,
        '--confirm',
        moveProposal.token,
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect(JSON.stringify(await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Controlled magnetar note')
    await hydra.owner({
      args: [
        'approval',
        'dismiss',
        moveProposal.token,
      ],
    })
    moveProposal = parsed(await pnyxAxi({
      args: [
        ...move,
        '--propose',
      ],
      env,
    }))
    await hydra.owner({
      args: [
        'approval',
        'confirm',
        moveProposal.token,
        '--confirm',
        moveProposal.token,
      ],
    })

    expect(JSON.stringify(await other.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).toContain('Controlled magnetar note')

    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Controlled axion line',
      ],
    })
    const learningMove = [
      'owner',
      'memory',
      'move',
      '--project',
      project,
      '--text',
      'Controlled axion line',
      '--hydra',
      hydra.id,
    ]
    expect((await pnyxAxi({
      args: learningMove,
      env,
    })).stdout).toContain('OWNER_ONLY')
    let learningProposal = parsed(await pnyxAxi({
      args: [
        ...learningMove,
        '--propose',
      ],
      env,
    }))
    expect(JSON.stringify(await other.owner({
      args: [
        'project',
        'show',
        project,
      ],
    }))).not.toContain('Controlled axion line')
    await other.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        project,
        '--key',
        'preferences',
        '--text',
        'Latest project preference',
        '--reason',
        'test changed destination',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'approval',
        'confirm',
        learningProposal.token,
        '--confirm',
        learningProposal.token,
      ],
    })).code).toBe('REVISION_CONFLICT')
    await hydra.owner({
      args: [
        'approval',
        'dismiss',
        learningProposal.token,
      ],
    })
    learningProposal = parsed(await pnyxAxi({
      args: [
        ...learningMove,
        '--propose',
      ],
      env,
    }))
    await hydra.owner({
      args: [
        'approval',
        'confirm',
        learningProposal.token,
        '--confirm',
        learningProposal.token,
      ],
    })
    expect(JSON.stringify(await other.owner({
      args: [
        'project',
        'show',
        project,
      ],
    }))).toContain('Controlled axion line')
  },
)

test(
  'owner-memory revisions cannot cross a home-polis change',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            'revision-first': { readers: [hydra.id] },
            'revision-next': { readers: [hydra.id] },
            'revision-final': { readers: [hydra.id] },
          },
        }),
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-first',
        '--read-poleis',
        'revision-first,revision-next,revision-final',
      ],
    })
    const first = await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'revision-first',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-next',
      ],
    })
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'revision-next',
      ],
    })

    expect((await hydra.ownerRefused({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'stale replacement',
        '--if-revision',
        String(first.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect((await hydra.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'preferences',
        '--to',
        'revision-next',
        '--if-revision',
        String(first.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    const current = await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(current.writable.preferences.text).toBe('revision-next')
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'fresh replacement',
        '--if-revision',
        String(current.revision),
      ],
    })
    expect((await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('fresh replacement')
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-final',
      ],
    })
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'revision-final',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-next',
      ],
    })
    const path = join(
      process.env.PNYX_HOME!,
      'owner',
      'poleis',
      'revision-next',
      'memory.jsonl',
    )
    const beforeCorruption = readFileSync(path)
    const firstPath = join(
      process.env.PNYX_HOME!,
      'owner',
      'poleis',
      'revision-first',
      'memory.jsonl',
    )
    const beforeFirst = readFileSync(firstPath)

    try {
      const corruptMoves = readFileSync(
        new URL(
          './setup/fixtures/memory/corrupt-owner-moves.jsonl',
          import.meta.url,
        ),
        'utf8',
      ).trimEnd()
        .split('\n')

      for (const invalidEntry of corruptMoves.slice(
        0,
        3,
      )) {
        appendFileSync(
          path,
          `${invalidEntry}\n`,
        )
        const memory = await hydra.owner({
          args: [
            'owner',
            'memory',
            'list',
          ],
        })
        expect(memory.writable.preferences.text).toBe('fresh replacement')
        expect(JSON.stringify(memory.memory)).not.toMatch(/Invalid (local sequence|imported sequence|source rewrite|destination rewrite)/)
        expect((await hydra.ownerRefused({
          args: [
            'owner',
            'memory',
            'set',
            '--key',
            'preferences',
            '--text',
            'Overwrite corrupt log',
          ],
        })).code).toBe('LOG_CORRUPT')
        writeFileSync(
          path,
          beforeCorruption,
        )
      }

      appendFileSync(
        path,
        `${corruptMoves.slice(3).join('\n')}\n`,
      )
      appendFileSync(
        firstPath,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-dependent.jsonl',
          import.meta.url,
        )),
      )
      expect((await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })).writable.preferences.text).toBe('fresh replacement')
      const combined = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(JSON.stringify(combined.memory)).not.toContain('conflicting replacement')
      expect(JSON.stringify(combined.memory)).not.toContain('Rejected source-position import')
      expect(JSON.stringify(combined.memory)).not.toContain('Rejected dependent-source import')
      expect(JSON.stringify(combined.memory)).toContain('revision-final')
      expect(JSON.stringify(combined.memory)).toContain('revision-first')
      expect((await hydra.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite corrupt log',
        ],
      })).code).toBe('LOG_CORRUPT')
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
      appendFileSync(
        path,
        '{"seq":3,"key":"preferences","after":42}\n',
      )
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-valid-source.jsonl',
          import.meta.url,
        )),
      )
      const invalidTail = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(invalidTail.writable.preferences?.text).toBe('fresh replacement')
      expect(JSON.stringify(invalidTail.memory)).not.toContain('Rejected destination-conflict import')
      writeFileSync(
        path,
        beforeCorruption,
      )
      appendFileSync(
        path,
        '{"seq":3,"key":"learnings","after":null,"projectMove":{"project":42}}\n',
      )
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-valid-source.jsonl',
          import.meta.url,
        )),
      )
      const malformedProjectMove = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(malformedProjectMove.writable.preferences?.text).toBe('fresh replacement')
      expect(JSON.stringify(malformedProjectMove.memory)).not.toContain('Rejected destination-conflict import')
      writeFileSync(
        path,
        beforeCorruption,
      )
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-gap.jsonl',
          import.meta.url,
        )),
      )
      const gap = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(gap.writable.preferences.text).toBe('fresh replacement')
      expect(JSON.stringify(gap.memory)).not.toContain('Rejected source-gap import')
      expect(JSON.stringify(gap.memory)).toContain('revision-first')
      expect((await hydra.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite gapped log',
        ],
      })).code).toBe('LOG_CORRUPT')
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--polis',
          'revision-first',
        ],
      })
      expect((await hydra.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Reuse rejected destination position',
        ],
      })).code).toBe('LOG_CORRUPT')
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-valid-source.jsonl',
          import.meta.url,
        )),
      )
      appendFileSync(
        firstPath,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-destination-conflict.jsonl',
          import.meta.url,
        )),
      )
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--polis',
          'revision-next',
        ],
      })
      const rejectedDestination = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(rejectedDestination.writable.preferences?.text).toBe('fresh replacement')
      expect(JSON.stringify(rejectedDestination.memory)).toContain('revision-first')
      expect(JSON.stringify(rejectedDestination.memory)).not.toContain('Rejected destination-conflict import')
      expect(JSON.stringify(rejectedDestination.memory)).not.toContain('Conflicting destination replacement')
      expect((await hydra.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite rejected source move',
        ],
      })).code).toBe('LOG_CORRUPT')
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
      appendFileSync(
        path,
        [
          '{"v":1,"seq":4,"at":"2026-01-01T00:00:00Z","actor":"web","key":"preferences","before":"Earlier logical entry","after":"Out-of-order replacement"}',
          '{"v":1,"seq":3,"at":"2026-01-01T00:00:00Z","actor":"web","key":"preferences","before":"fresh replacement","after":"Earlier logical entry"}',
          '',
        ].join('\n'),
      )
      const outOfOrder = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(outOfOrder.writable.preferences.text).toBe('fresh replacement')
      expect((await hydra.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite out-of-order log',
        ],
      })).code).toBe('LOG_CORRUPT')
    } finally {
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
    }
  },
)

test(
  'memory move confirmation refuses a changed destination audience',
  async () => {
    const author = await pnyx.hydra()
    const reader = await pnyx.hydra()
    const newcomer = await pnyx.hydra()
    await author.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            'audience-private': { readers: [author.id] },
            'audience-destination': {
              readers: [
                author.id,
                reader.id,
                newcomer.id,
              ],
            },
          },
        }),
      ],
    })
    await author.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'audience-private',
        '--read-poleis',
        'audience-private,audience-destination',
      ],
    })
    await reader.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'audience-destination',
      ],
    })
    await author.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Audience-bound cobalt preference',
      ],
    })
    const proposal = parsed(await pnyxAxi({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'preferences',
        '--to',
        'audience-destination',
        '--propose',
        '--hydra',
        author.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: author.id,
        PNYX_TASK: undefined,
      },
    }))
    expect(proposal.confirmation).toBe('needed')
    await newcomer.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'audience-destination',
      ],
    })
    expect((await author.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposal.token,
        '--confirm',
        proposal.token,
      ],
    })).code).toBe('CONFLICT')
    expect((await author.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('Audience-bound cobalt preference')
    expect(JSON.stringify(await reader.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).not.toContain('Audience-bound cobalt preference')

    const grant = await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            'audience-private': {
              readers: [
                author.id,
                newcomer.id,
              ],
            },
          },
        }),
        '--propose',
        '--hydra',
        author.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: author.id,
        PNYX_TASK: undefined,
      },
    })
    expect(grant.status).toBe(0)
    const readerGrant = parsed(grant)
    expect(readerGrant.confirmation).toBe('needed')
    await newcomer.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'audience-destination,audience-private',
      ],
    })
    expect((await author.ownerRefused({
      args: [
        'approval',
        'confirm',
        readerGrant.token,
        '--confirm',
        readerGrant.token,
      ],
    })).code).toBe('CONFLICT')
    const newcomerMemory = await newcomer.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(JSON.stringify(newcomerMemory.memory)).not.toContain('Audience-bound cobalt preference')
  },
)

test(
  'async memory contexts stop after three access changes',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ poleis: { 'bound-home': { readers: [hydra.id] } } }),
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,bound-home',
      ],
    })
    let attempts = 0
    await expect(readMemoryContext({
      read: async () => {
        attempts++
        await hydra.owner({
          args: [
            'hydra',
            'set',
            '--polis',
            'bound-home',
          ],
        })
        await hydra.owner({
          args: [
            'hydra',
            'set',
            '--polis',
            'shared',
          ],
        })

        return 'Unreadable stale summary'
      },
    })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(attempts).toBe(3)
  },
)

test(
  'native cross-Hydra controls require every target memory capability',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    await target.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            shared: { readers: ['*'] },
            'control-private': { readers: [target.id] },
          },
        }),
      ],
    })
    await target.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'control-private',
        '--read-poleis',
        'shared,control-private',
      ],
    })
    const folder = target.folder({ name: 'capability-target' })
    await target.owner({
      args: [
        'task',
        'create',
        '--key',
        'capability-target',
        '--title',
        'Capability target',
        '--folder',
        folder,
        '--brief',
        'Original capability brief',
      ],
    })
    const task = await target.task({ key: 'capability-target' })
    const env = {
      ...process.env,
      PNYX_ACTOR: 'hydra',
      PNYX_HYDRA: caller.id,
      PNYX_TASK: undefined,
    }
    const controls = [
      [
        'task',
        'create',
        '--title',
        'Unauthorized task',
        '--brief',
        'Unauthorized brief',
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'start',
        task.id,
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'continue',
        task.id,
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'reply',
        task.id,
        '--text',
        'Private worker query',
      ],
      [
        'task',
        'attach',
        task.id,
        '--session',
        'unavailable-session',
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'brief',
        task.id,
        '--brief',
        'Unauthorized brief',
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'status',
        task.id,
        'working',
        '--note',
        'Unauthorized status',
      ],
      [
        'task',
        'stop',
        task.id,
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'tools',
        task.id,
        '--grant',
        'browser',
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'move',
        task.id,
        '--to-hydra',
        caller.id,
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'agent',
        task.id,
        'mode',
        'bypass',
      ],
      [
        'hydra',
        'set',
        '--name',
        'Unauthorized name',
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'hydra',
        'usage',
        'refresh',
      ],
      [
        'settings',
        'set',
        '--json',
        '{"logDays":15}',
        '--reason',
        'Test cross-Hydra capability',
      ],
      [
        'task',
        'brief',
        task.id,
        '--brief',
        'Spoofed actor brief',
        '--actor',
        'cli',
      ],
    ]

    for (const args of controls) {
      const refused = await pnyxAxi({
        args: [
          ...args,
          `--hydra=${target.id}`,
        ],
        env,
      })
      expect(
        parsed(refused),
        args.join(' '),
      ).toMatchObject({
        code: 'NOT_FOUND',
        error: 'not found',
      })
    }

    expect(pnyx.claude.sessions.some(session => session.cwd === folder)).toBe(false)
    const namedCreate = await pnyxAxi({
      args: [
        'hydra',
        'create',
        target.id,
        '--name',
        'Unauthorized target',
      ],
      env,
    })
    expect(parsed(namedCreate)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'not found',
    })
    await caller.owner({
      args: [
        'task',
        'create',
        '--key',
        'move-capability',
        '--title',
        'Move capability',
        '--brief',
        'Original caller task',
      ],
    })
    const moved = await pnyxAxi({
      args: [
        'task',
        'move',
        'move-capability',
        '--to-hydra',
        target.id,
        '--reason',
        'Test destination capability',
      ],
      env,
    })
    expect(parsed(moved)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'not found',
    })
    expect((await caller.task({ key: 'move-capability' })).title).toBe('Move capability')

    expect((await target.task({ key: task.id })).brief).toBe('Original capability brief')
    const missing = await pnyxAxi({
      args: [
        'task',
        'start',
        task.id,
        '--hydra',
        'missing-control-hydra',
        '--reason',
        'Test missing target',
      ],
      env,
    })
    expect(parsed(missing)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'not found',
    })
    const visibleTask = await pnyxAxi({
      args: [
        'task',
        '--hydra',
        target.id,
        'show',
        task.id,
      ],
      env,
    })
    expect(visibleTask.status).toBe(0)
    expect(parsed(visibleTask).task.id).toBe(task.id)
    const implicitMemoryRead = await pnyxAxi({
      args: [
        'hydra',
        'memory',
        '--hydra',
        target.id,
      ],
      env,
    })
    expect(implicitMemoryRead.status).toBe(0)
    expect(parsed(implicitMemoryRead).memory).toBe('none: no Hydra memory yet')
    await target.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'shared',
      ],
    })
    const extraReads = await pnyxAxi({
      args: [
        'task',
        'start',
        task.id,
        '--hydra',
        target.id,
        '--reason',
        'Test target extra reads',
      ],
      env,
    })
    expect(parsed(extraReads)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'not found',
    })
  },
)

test(
  'a failed hosted memory read preserves the next change notice',
  async () => {
    const hydra = await pnyx.hydra()
    const path = hydra.folder({ name: 'checkpoint-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const { worker } = await hydra.startTask({ key: 'checkpoint-worker' })
    const main = await hydra.chat({ text: 'Remember the initial memory checkpoint' })
    await until({
      what: 'the initial checkpoint turn',
      check: () => main.answered === 1,
    })
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Changed checkpoint preference',
      ],
    })
    const gateBin = hydra.folder({ name: 'checkpoint-git-gate' })
    const git = join(
      gateBin,
      'git',
    )
    copyFileSync(
      new URL(
        './setup/fixtures/memory/git-read-gate.mjs',
        import.meta.url,
      ),
      git,
    )
    chmodSync(
      git,
      0o755,
    )
    const sockets: Socket[] = []
    const gate = createServer(socket => sockets.push(socket))
    const socketPath = join(
      gateBin,
      'gate.sock',
    )
    await new Promise<void>(resolve => gate.listen(
      socketPath,
      resolve,
    ))
    const previousPath = process.env.PATH
    process.env.PATH = `${gateBin}:${previousPath}`
    process.env.PNYX_TEST_GIT_PROJECT = path
    process.env.PNYX_TEST_GIT_SOCKET = socketPath

    try {
      await hydra.as({ session: worker }).run({
        args: [
          'hydra',
          'send',
          '--task',
          'checkpoint-worker',
          '--text',
          'First checkpoint report',
        ],
      })

      for (const [
        index,
        reads,
      ] of [
          'shared,work',
          'shared',
          'shared,work',
        ].entries()) {
        await until({
          what: 'the hosted memory read to reach Git',
          check: () => sockets.length === index + 1,
        })
        await hydra.owner({
          args: [
            'hydra',
            'set',
            '--read-poleis',
            reads,
          ],
        })
        sockets[index]!.end()
      }

      await until({
        what: 'the hosted context retry bound',
        check: async () => JSON.stringify(await hydra.owner({ args: ['history'] })).includes('Memory access kept changing'),
      })
      expect(main.received).toHaveLength(1)
      delete process.env.PNYX_TEST_GIT_PROJECT
      await hydra.as({ session: worker }).run({
        args: [
          'hydra',
          'send',
          '--task',
          'checkpoint-worker',
          '--text',
          'Second checkpoint report',
        ],
      })
      await until({
        what: 'the recovered wake',
        check: () => main.received.length > 1,
      })
      expect(main.received.slice(1).join('\n')).toContain('Memory changed; load owner memory')
    } finally {
      process.env.PATH = previousPath
      delete process.env.PNYX_TEST_GIT_PROJECT
      delete process.env.PNYX_TEST_GIT_SOCKET
      sockets.forEach(socket => socket.destroy())
      await new Promise<void>(resolve => gate.close(() => resolve()))
    }
  },
)

test(
  'agent update history filters before applying its page limit',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Visible update',
        '--key',
        'update',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'memory',
        'set',
        '--key',
        'note',
        '--text',
        'Bookkeeping',
        '--reason',
        'test',
      ],
    })
    const history = await pnyxAxi({
      args: [
        'history',
        '--updates',
        '--limit',
        '1',
        '--hydra',
        hydra.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: hydra.id,
        PNYX_TASK: undefined,
      },
    })
    expect(history.status).toBe(0)
    expect(parsed(history).events[0].type).toBe('task.created')
  },
)

test(
  'project listing ignores Hydra option placement across private home poleis',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    await target.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'private-target',
      ],
    })
    const env = {
      ...process.env,
      PNYX_ACTOR: 'hydra',
      PNYX_HYDRA: caller.id,
      PNYX_TASK: undefined,
    }
    const listed = await pnyxAxi({
      args: [
        'project',
        '--hydra',
        target.id,
        'list',
      ],
      env,
    })
    expect(listed.status).toBe(0)
    expect(parsed(listed).projects).toBe('none: no projects attached')
  },
)

test(
  'completed project confirmation retries keep their pinned revision',
  async () => {
    const hydra = await pnyx.hydra()
    const path = hydra.folder({ name: 'confirmation-retry' })
    await hydra.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const saved = await hydra.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        'Retry this learning',
        '--reason',
        'test',
      ],
    })
    const args = [
      'project',
      'memory',
      'confirm',
      '--project',
      path,
      '--text',
      'Retry this learning',
      '--reason',
      'Evidence',
      '--event-id',
      'confirmation-retry',
      '--if-revision',
      String(saved.revision),
    ]
    const first = await hydra.owner({ args })
    const retry = await hydra.owner({ args })
    expect(retry.skipped).toBe('duplicate')
    expect(retry.revision).toBe(first.revision)
    expect((await hydra.ownerRefused({
      args: [
        ...args.slice(
          0,
          -4,
        ),
        '--event-id',
        'new-confirmation',
        '--if-revision',
        String(saved.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
  },
)

test(
  'settings retries survive revoking the calling Hydra access',
  async () => {
    const hydra = await pnyx.hydra()
    const other = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            'retry-polis': {
              readers: [
                hydra.id,
                other.id,
              ],
            },
          },
        }),
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,retry-polis',
      ],
    })
    const args = [
      'settings',
      'set',
      '--json',
      JSON.stringify({ poleis: { 'retry-polis': { readers: [other.id] } } }),
      '--event-id',
      'settings-retry',
      '--actor',
      'hydra',
      '--hydra',
      hydra.id,
    ]
    const env = {
      ...process.env,
      PNYX_ACTOR: 'hydra',
      PNYX_HYDRA: hydra.id,
      PNYX_TASK: undefined,
    }
    const first = await pnyxAxi({
      args,
      env,
    })
    expect(first.status).toBe(0)
    const retry = await pnyxAxi({
      args,
      env,
    })
    expect(retry.status).toBe(0)
    expect(parsed(retry).event).toBe('none: duplicate')
    expect(parsed(retry).revision).toBe(parsed(first).revision)
    expect(retry.stdout).not.toContain('retry-polis')
  },
)

test(
  'project move confirmation pins the destination Hydra read lists',
  async () => {
    const author = await pnyx.hydra()
    const reader = await pnyx.hydra()
    const path = author.folder({ name: 'project-audience-pin' })
    await author.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    await author.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            'project-source': { readers: [author.id] },
            'project-destination': {
              readers: [
                author.id,
                reader.id,
              ],
            },
          },
        }),
      ],
    })
    await author.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,project-source,project-destination',
      ],
    })
    await author.owner({
      args: [
        'project',
        'move',
        path,
        '--polis',
        'project-source',
      ],
    })
    const proposal = parsed(await pnyxAxi({
      args: [
        'project',
        'move',
        path,
        '--polis',
        'project-destination',
        '--propose',
        '--hydra',
        author.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: author.id,
        PNYX_TASK: undefined,
      },
    }))
    expect(proposal.confirmation).toBe('needed')
    await reader.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,project-destination',
      ],
    })
    expect((await author.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposal.token,
        '--confirm',
        proposal.token,
      ],
    })).code).toBe('CONFLICT')
    await author.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        'shared,project-source',
      ],
    })
    expect(JSON.stringify(await author.owner({
      args: [
        'project',
        'list',
      ],
    }))).toContain('project-audience-pin')
  },
)
