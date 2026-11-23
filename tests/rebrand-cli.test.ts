import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { compatibleEnvironment } from '#store/legacy-env.ts'
import { CLI } from './setup/othrys.ts'

test(
  'both legacy executable paths still start the rebranded CLI',
  () => {
    for (const name of [
      'pnyx.js',
      'pnyx-axi.js',
    ]) {
      const output = execFileSync(
        process.execPath,
        [
          join(
            dirname(CLI),
            name,
          ),
          '--help',
        ],
        {
          env: process.env,
          encoding: 'utf8',
        },
      )
      expect(output).toContain('usage: othrys')
    }
  },
)

test(
  'new environment values take precedence while legacy identities and homes remain inputs',
  () => {
    expect(compatibleEnvironment({
      env: {
        PNYX_HOME: '/old',
        OTHRYS_HOME: '/new',
        PNYX_HYDRA: 'west',
        PNYX_ACTOR: 'worker:task',
        PNYX_TASK: 'task',
        PNYX_STEERING_WORKER: 'session',
        PNYX_WORKER_HOME: '/captured',
      },
    })).toMatchObject({
      OTHRYS_HOME: '/new',
      OTHRYS_TITAN: 'west',
      OTHRYS_ACTOR: 'worker:task',
      OTHRYS_TASK: 'task',
      OTHRYS_STEERING_WORKER: 'session',
      OTHRYS_WORKER_HOME: '/captured',
    })
  },
)
