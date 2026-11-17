import { beforeAll, expect, test } from 'vitest'
import { startPnyx, pnyxAxi, type Pnyx } from './setup/pnyx.ts'

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
        '{"memorySpaces":{}}',
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
