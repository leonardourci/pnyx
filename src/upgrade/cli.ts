import { parseArgs } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import { flagError } from '../app/cli-support.ts'
import { serverPids } from '../app/server.ts'
import { RESTART_SIGNAL } from './restart.ts'
import { runUpgrade, upgradeAvailable } from './runner.ts'
import { STEP_WORDS } from './model.ts'

export const UPGRADE_HELP = `usage: pnyx-axi upgrade [--check]
Pulls main into the Pnyx folder, installs and builds, then restarts the running server. Any failed step goes back to the previous version without restarting.
A folder off main or with local changes is refused. --check only says whether main has something newer.
Ctrl-C stops it and goes back to the previous version; \`pnyx-axi hydra stop\` does the same for a /upgrade sent in Hydra's chat.
`

const OPTIONS = { check: { type: 'boolean' } } as const

// eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
export async function upgrade(args: string[]): Promise<Record<string, unknown>> {
  let check: boolean | undefined

  try {
    check = parseArgs({
      args,
      options: OPTIONS,
      strict: true,
    }).values.check
  } catch (error) {
    throw flagError({
      error,
      options: OPTIONS,
    })
  }

  if (check) {
    const available = await upgradeAvailable()

    return available === undefined ? {
      upgrade: 'unknown: origin main could not be read',
      help: ['Check the network and the Pnyx folder\'s origin remote'],
    } : available ? {
      upgrade: 'available',
      help: ['Run `pnyx-axi upgrade` to upgrade'],
    } : { upgrade: 'none: Pnyx is up to date' }
  }

  // Hydra can only propose it (owner-only); a worker cannot restart the server under everyone.
  if (process.env.PNYX_ACTOR?.startsWith('worker:')) {
    throw new AxiError(
      'Only the owner can upgrade Pnyx',
      'OWNER_ONLY',
      ['Ask the owner to run `pnyx-axi upgrade` or send /upgrade in Hydra\'s chat'],
    )
  }

  const stopping = new AbortController()
  const stop = () => stopping.abort()
  process.once(
    'SIGINT',
    stop,
  )
  let result: Awaited<ReturnType<typeof runUpgrade>>

  try {
    result = await runUpgrade({ signal: stopping.signal })
  } finally {
    process.off(
      'SIGINT',
      stop,
    )
  }

  if (result.state === 'refused') {
    throw new AxiError(
      `Upgrade not started: ${result.reasons!.join(' ')} Nothing was stashed or changed.`,
      'UPGRADE_REFUSED',
      ['Resolve each reason listed, then run `pnyx-axi upgrade` again'],
    )
  }

  if (result.state === 'failed') {
    throw new AxiError(
      `Upgrade failed while ${STEP_WORDS[result.failed!][1].toLowerCase()}; ${result.rolledBack ? 'went back to the previous version' : 'going back to the previous version failed, so the folder may be partly upgraded'}.\n${result.error}`,
      'UPGRADE_FAILED',
      ['Fix the cause, then run `pnyx-axi upgrade` again'],
    )
  }

  if (result.state === 'stopped') {
    if (result.rolledBack === false) {
      throw new AxiError(
        `Upgrade stopped; going back to the previous version failed, so the folder may be partly upgraded.\n${result.error}`,
        'UPGRADE_STOPPED',
        ['Fix the cause, then run `pnyx-axi upgrade` again'],
      )
    }

    return {
      steps: result.steps,
      result: 'stopped: Upgrade stopped; nothing changed',
    }
  }

  if (result.state === 'current') {
    return {
      steps: result.steps,
      result: 'none: Pnyx is already up to date',
    }
  }

  const pids = await serverPids()

  for (const pid of pids) {
    process.kill(
      pid,
      RESTART_SIGNAL,
    )
  }

  if (!pids.length) {
    return {
      steps: result.steps,
      result: 'Upgraded',
      help: ['Run `pnyx-axi serve` to start the server'],
    }
  }

  return {
    steps: [
      ...result.steps,
      {
        step: 'restart',
        state: 'done',
        seconds: 0,
      },
    ],
    result: 'Upgraded',
  }
}
