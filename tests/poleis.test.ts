import { beforeAll, expect, test } from 'vitest'
import { searchInBackground } from '#oracle/search-background.ts'
import { runForClient } from '#app/request-context.ts'
import { appendFileSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { startPnyx, pnyxAxi, parsed, until, type Pnyx } from './setup/pnyx.ts'

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
    expect(JSON.stringify(await work.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    }))).not.toContain('Private comet learning')
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
    }))).toContain('Secret nebula preference')
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
        'Work header quasar',
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
    const { worker } = await work.startTask({ key: 'polis-header' })
    expect(worker.received.join('\n')).toContain('Work header quasar')
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
    expect(digest).not.toContain('Secret nebula')
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
    }))).not.toContain('Secret nebula')
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
    const hidden = await pnyx.hydra()
    const unattached = await pnyx.hydra()
    const path = allowed.folder({ name: 'polis-project' })
    const privatePath = unattached.folder({ name: 'polis-project' })

    await allowed.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const sharing = await hidden.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    await hidden.owner({
      args: [
        'project',
        'add',
        path,
        '--confirm',
        sharing.token,
      ],
    })
    await unattached.owner({
      args: [
        'project',
        'add',
        privatePath,
      ],
    })
    const privateSharing = await allowed.owner({
      args: [
        'project',
        'add',
        privatePath,
      ],
    })
    await allowed.owner({
      args: [
        'project',
        'add',
        privatePath,
        '--confirm',
        privateSharing.token,
      ],
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
    expect(JSON.stringify(await allowed.owner({
      args: [
        'project',
        'show',
        'polis-project',
      ],
    }))).toContain('Project pulsar learning')
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
    }))).not.toContain('polis-project')
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
    expect((await hidden.ownerRefused({
      args: [
        'project',
        'show',
        path,
      ],
    })).code).toBe('NOT_FOUND')
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
    const gate = createServer(socket => {
      sockets.push(socket)

      if (released) {
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
        check: () => sockets.length === 2,
      })
      await allowed.owner({
        args: [
          'project',
          'remove',
          'polis-project',
        ],
      })
      sockets[0]!.end()
      sockets[1]!.end()
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
      const reattach = await allowed.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
      await allowed.owner({
        args: [
          'project',
          'add',
          path,
          '--confirm',
          reattach.token,
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
      const previousReads = sockets.length
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
          'polis-project',
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
  'Hydra proposes wider polis access for Confirm and narrows directly',
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

    const project = hydra.folder({ name: 'permission-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    const attach = await other.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    await other.owner({
      args: [
        'project',
        'add',
        project,
        '--confirm',
        attach.token,
      ],
    })
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
    }))).not.toContain('permission-project')
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
    const projectProposal = parsed(await pnyxAxi({
      args: [
        'project',
        'move',
        project,
        '--polis',
        'shared',
        '--propose',
        '--hydra',
        hydra.id,
      ],
      env,
    }))
    expect(JSON.stringify(await other.owner({
      args: [
        'project',
        'list',
      ],
    }))).not.toContain('permission-project')
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
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/corrupt-owner-moves.jsonl',
          import.meta.url,
        )),
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
      expect(JSON.stringify(combined.memory)).not.toContain('Invalid destination rewrite')
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
