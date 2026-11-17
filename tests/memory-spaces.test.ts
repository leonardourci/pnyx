import { beforeAll, expect, test } from 'vitest'
import { startPnyx, pnyxAxi, parsed, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'memory spaces enforce both locks and resolve every write from the Hydra',
  async () => {
    const work = await pnyx.hydra()
    expect((await work.ownerRefused({
      args: [
        'settings',
        'set',
        '--json',
        '{"memorySpaces":{"shared":null}}',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await work.ownerRefused({
      args: [
        'hydra',
        'set',
        '--memory-write',
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
          memorySpaces: {
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
        '--memory-reads',
        'shared,work',
        '--memory-write',
        'work',
      ],
    })
    await personal.owner({
      args: [
        'hydra',
        'set',
        '--memory-reads',
        'personal',
        '--memory-write',
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
      args: ['hydra', 'memory', 'set', '--key', 'scope', '--text', 'Private Hydra scope'],
    })
    const crossHydraRead = await pnyxAxi({
      args: ['hydra', 'memory', 'list', '--hydra', personal.id],
      env: crossEnv,
    })
    expect(crossHydraRead.status).toBe(0)
    expect(crossHydraRead.stdout).not.toContain('Private Hydra scope')
    const crossHydraWrite = await pnyxAxi({
      args: ['hydra', 'memory', 'forget', '--key', 'scope', '--hydra', personal.id],
      env: crossEnv,
    })
    expect(crossHydraWrite.status).not.toBe(0)
    expect(crossHydraWrite.stdout).toContain('NOT_FOUND')
    expect(JSON.stringify(await personal.owner({
      args: ['hydra', 'memory', 'list'],
    }))).toContain('Private Hydra scope')
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
    expect((await pnyxAxi({
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
    })).stdout).toContain('NOT_FOUND')
    expect((await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--memory-reads',
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
    })).hydra.memory.reads).toEqual([])
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
    const hiddenSpaceEdit = await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        '{"memorySpaces":{"personal":null}}',
        '--hydra',
        work.id,
      ],
      env: crossEnv,
    })
    expect(hiddenSpaceEdit.status).not.toBe(0)
    expect(hiddenSpaceEdit.stdout).toContain('NOT_FOUND')
    expect(JSON.stringify(await personal.owner({
      args: ['owner', 'memory', 'list'],
    }))).toContain('Secret nebula preference')
    const selfGrant = await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--memory-reads',
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
    const { worker } = await work.startTask({ key: 'space-header' })
    expect(worker.received.join('\n')).toContain('Work header quasar')
    expect(worker.received.join('\n')).not.toContain('Secret header nebula')
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
        '--memory-reads',
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
        '--memory-reads',
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
        '--memory-reads',
        'shared,work,personal',
        '--memory-write',
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
  },
)

test(
  'project memory has one space and requires attachment and both read locks',
  async () => {
    const allowed = await pnyx.hydra()
    const hidden = await pnyx.hydra()
    const path = allowed.folder({ name: 'spaced-project' })

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
    await allowed.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          memorySpaces: {
            shared: { readers: ['*'] },
            vault: { readers: [allowed.id] },
          },
        }),
      ],
    })
    await allowed.owner({
      args: [
        'hydra',
        'set',
        '--memory-reads',
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
    await hidden.owner({
      args: [
        'hydra',
        'set',
        '--memory-reads',
        'shared,vault',
      ],
    })
    await allowed.owner({
      args: [
        'project',
        'move',
        path,
        '--space',
        'vault',
      ],
    })
    expect(JSON.stringify(await hidden.owner({
      args: [
        'project',
        'list',
      ],
    }))).not.toContain('spaced-project')
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
    })).stdout).not.toContain('Project pulsar')
    expect(JSON.stringify(await hidden.owner({
      args: [
        'oracle',
        'pulsar',
      ],
    }))).not.toContain('Project [pulsar]')
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
        'Write project while owner write space remains shared',
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
  },
)

test(
  'Hydra proposes wider memory access for Confirm and narrows directly',
  async () => {
    const hydra = await pnyx.hydra()
    const other = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          memorySpaces: {
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
        '--memory-reads',
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
    const widerReads = [
      'hydra',
      'set',
      '--memory-reads',
      'shared,controlled,extra',
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
    })).hydra.memory.reads).toEqual([
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
    })).hydra.memory.reads).toEqual([
      'shared',
      'controlled',
      'extra',
    ])
    expect((await pnyxAxi({
      args: [
        'hydra',
        'set',
        '--memory-reads',
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
        memorySpaces: {
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
    })).settings.memorySpaces.controlled.readers).toEqual([hydra.id])
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
    })).settings.memorySpaces.controlled.readers).toEqual([
      hydra.id,
      other.id,
    ])
    expect((await pnyxAxi({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ memorySpaces: { controlled: { readers: [hydra.id] } } }),
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
    })).settings.memorySpaces.controlled.readers).toEqual([hydra.id])

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
        '--space',
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
        '--space',
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
        '--space',
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
        '--memory-write',
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
    expect((await pnyxAxi({
      args: move,
      env,
    })).stdout).toContain('OWNER_ONLY')
    const moveProposal = parsed(await pnyxAxi({
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
    const learningProposal = parsed(await pnyxAxi({
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
