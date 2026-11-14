import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import { flagError } from '#app/cli-support.ts'
import { DEFAULT_HYDRA } from '#app/home-migration.ts'
import { requestEnv } from '#app/request-context.ts'
import { workerIdentity } from '#workers/worker-identity.ts'
import { askHost, probeServer } from '#app/server-state.ts'
import { send } from '#cli/client.ts'
import { restartPnyx, untilAgentsIdle } from './restart.ts'
import { RESTART_PENDING_MS, stopUpgrade } from './queue.ts'
import { PNYX_ROOT, runUpgrade, upgradeAvailable } from './runner.ts'
import { COMMIT_LENGTH, STEP_WORDS, type UpgradeOperation, type UpgradeStep } from './model.ts'

export const UPGRADE_HELP = `usage: pnyx-axi upgrade [--check] [--now] [--stop] [--hydra <id>]
Pulls main into the Pnyx folder, installs and builds, checks that the new build can import every Hydra still kept in events.jsonl (\`setup postgres --check\`), then restarts the server once no agent is mid-turn, or after 15 minutes at most; --now restarts right after the build. Agents stop with the server; turns it cuts resume from their saved sessions. Any failed step goes back to the previous version without restarting. An upgrade cut before it ended leaves the previous build working, and the next upgrade finishes it.
The running server does the upgrade, as it does for /upgrade in Hydra's chat, and this command waits for it, printing each step as it goes; the Hydra's chat (--hydra, else the default one) shows it too. Ctrl-C only stops the waiting. With no server running, the upgrade runs here, and Ctrl-C stops it and goes back to the previous version. A server that runs but does not answer, or does not run the named Hydra, refuses it; \`pnyx-axi restart\` replaces a stuck server.
--stop stops the upgrade the server is pulling, installing, building or checking, whichever Hydra asked for it, and goes back to the previous version; a built upgrade waiting to restart cannot be stopped.
A folder off main or with local changes is refused. --check only says whether there is something to upgrade: a newer main, or an upgrade cut after its pull.
`

const OPTIONS = {
  check: { type: 'boolean' },
  now: { type: 'boolean' },
  stop: { type: 'boolean' },
  hydra: { type: 'string' },
  // Sent by the terminal to the server it hands the upgrade to: the id of the upgrade it watches.
  'event-id': { type: 'string' },
} as const

// How often a terminal asks the server how far its upgrade is.
const WATCH_MS = 500
// How long the server may stay silent, as it does while it restarts, before the terminal gives up.
const SILENT_MS = 150_000
// A restarted server takes the upgrade; if none comes back up, the upgrade runs in the terminal.
const RESTART_FIRST = 'Run `pnyx-axi restart`, then `pnyx-axi upgrade` again'
// How long one question to the server may go unanswered; a busy server can hold its event loop for seconds.
const ANSWER_MS = 60_000

type Outcome = Pick<UpgradeOperation, 'steps' | 'to' | 'failed' | 'error' | 'reasons' | 'rolledBack'> & {
  state: UpgradeOperation['state']
}

const ENDED: UpgradeOperation['state'][] = [
  'done',
  'current',
  'failed',
  'refused',
  'stopped',
]

// One step as the terminal prints it: Pulling…, Pulled (3s), Building failed.
function stepLine({
  step,
  state,
  seconds,
}: UpgradeStep) {
  const [
    , doing,
    done,
  ] = STEP_WORDS[step]

  if (state === 'running') {
    return `${doing}…`
  }

  return state === 'done' ? `${done} (${seconds}s)` : `${doing} ${state}`
}

// Prints each step once as it starts and as it ends, on stderr so the answer stays the only thing on stdout.
function progressLines() {
  const printed = new Set<string>()

  return ({
    steps,
    restartBy,
  }: {
    steps: UpgradeStep[]
    restartBy?: string
  }) => {
    const lines = steps.map(stepLine)

    if (restartBy) {
      lines.push(`Restarting once no agent is mid-turn, by ${new Date(restartBy).toLocaleTimeString()} at the latest`)
    }

    for (const line of lines.filter(line => !printed.has(line))) {
      printed.add(line)
      process.stderr.write(`${line}\n`)
    }
  }
}

// What the command answers once the upgrade ended, wherever it ran.
function report({ outcome }: { outcome: Outcome }): Record<string, unknown> {
  if (outcome.state === 'refused') {
    throw new AxiError(
      `Upgrade not started: ${outcome.reasons!.join(' ')} Nothing was stashed or changed.`,
      'UPGRADE_REFUSED',
      ['Resolve each reason listed, then run `pnyx-axi upgrade` again'],
    )
  }

  if (outcome.state === 'failed' && outcome.failed === 'restart') {
    throw new AxiError(
      `Upgrade finished, but the restart failed; the upgraded code remains on disk.\n${outcome.error}`,
      'UPGRADE_FAILED',
      ['Run `pnyx-axi restart`'],
    )
  }

  if (outcome.state === 'failed') {
    throw new AxiError(
      `Upgrade failed${outcome.failed ? ` while ${STEP_WORDS[outcome.failed][1].toLowerCase()}` : ''}; ${outcome.rolledBack ? 'went back to the previous version' : 'going back to the previous version failed, so the folder may be partly upgraded'}.\n${outcome.error}`,
      'UPGRADE_FAILED',
      ['Fix the cause, then run `pnyx-axi upgrade` again'],
    )
  }

  if (outcome.state === 'stopped') {
    if (outcome.rolledBack === false) {
      throw new AxiError(
        `Upgrade stopped; going back to the previous version failed, so the folder may be partly upgraded.\n${outcome.error}`,
        'UPGRADE_STOPPED',
        ['Fix the cause, then run `pnyx-axi upgrade` again'],
      )
    }

    return {
      steps: outcome.steps,
      result: 'stopped: Upgrade stopped; nothing changed',
    }
  }

  if (outcome.state === 'current') {
    return {
      steps: outcome.steps,
      result: 'none: Pnyx is already up to date',
    }
  }

  const upgraded = {
    steps: outcome.steps,
    result: 'Upgraded',
  }

  if (!outcome.to) {
    return upgraded
  }

  return {
    ...upgraded,
    commit: outcome.to.slice(
      0,
      COMMIT_LENGTH,
    ),
  }
}

// Hands the upgrade to the running server and waits for it; undefined when the server did not take it.
async function handOver({
  hydraId,
  now,
}: {
  hydraId: string
  now?: boolean
}): Promise<Record<string, unknown> | undefined> {
  const flags = now ? ['--now'] : []

  const ask = async ({ id }: { id: string }) => {
    const server = await probeServer()

    if (server === 'stopped') {
      return undefined
    }

    // It may be in the middle of an upgrade; a second one in the same folder would race it.
    if (server === 'silent') {
      throw new AxiError(
        'The Pnyx server is running but does not answer',
        'SERVER_UNAVAILABLE',
        [RESTART_FIRST],
      )
    }

    // Upgrading here instead would run beside the server's own upgrades, and no chat would show it.
    if (!server.hydras.includes(hydraId)) {
      throw new AxiError(
        `The Pnyx server runs no Hydra ${hydraId}`,
        'NOT_FOUND',
        [`Name one it runs with --hydra: ${server.hydras.join(', ')}`],
      )
    }

    const answer = await send({
      port: server.info.port,
      timeout: ANSWER_MS,
      argv: [
        'upgrade',
        '--event-id',
        id,
        '--hydra',
        hydraId,
        ...flags,
      ],
    })

    // A server on a build without this hand-over refuses the flags, and runs nothing.
    try {
      return answer.exitCode === 0 ? JSON.parse(answer.stdout) as UpgradeOperation : undefined
    } catch {
      return undefined
    }
  }

  let operation: UpgradeOperation | undefined

  try {
    operation = await ask({ id: randomUUID() })
  } catch (error) {
    if (error instanceof AxiError) {
      throw error
    }

    // Only a refused connection is sure to have started nothing; a second upgrade beside the server's would race it.
    if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
      throw new AxiError(
        `The Pnyx server did not answer: ${(error as Error).message}`,
        'SERVER_UNAVAILABLE',
        [RESTART_FIRST],
      )
    }
  }

  if (!operation) {
    return undefined
  }

  const progress = progressLines()
  let silentSince: number | undefined

  while (!ENDED.includes(operation.state)) {
    progress(operation)
    await delay(WATCH_MS)
    let next: UpgradeOperation | undefined

    try {
      next = await ask({ id: operation.id })
    } catch {
      // The server restarts at the end of the upgrade; the next one answers for it.
    }

    if (next) {
      operation = next
      silentSince = undefined
      continue
    }

    if (silentSince === undefined) {
      silentSince = Date.now()
    }

    if (Date.now() - silentSince > SILENT_MS) {
      throw new AxiError(
        'The Pnyx server stopped answering during the upgrade',
        'SERVER_UNAVAILABLE',
        ['Run `pnyx-axi restart`, then `pnyx-axi upgrade --check`'],
      )
    }
  }

  progress(operation)

  return report({ outcome: operation })
}

// The upgrade as it runs with no server to do it, so a Pnyx that does not start can still be upgraded.
async function runHere({
  root,
  now,
}: {
  root: string
  now?: boolean
}) {
  const stopping = new AbortController()
  const stop = () => stopping.abort()
  const progress = progressLines()
  process.once(
    'SIGINT',
    stop,
  )
  let result: Awaited<ReturnType<typeof runUpgrade>>

  try {
    result = await runUpgrade({
      root,
      signal: stopping.signal,
      progress,
    })
  } finally {
    process.off(
      'SIGINT',
      stop,
    )
  }

  const {
    state,
    ...rest
  } = result

  if (state !== 'upgraded') {
    return report({
      outcome: {
        ...rest,
        state,
      },
    })
  }

  if (!now) {
    await untilAgentsIdle({ deadline: Date.now() + RESTART_PENDING_MS })
  }

  await restartPnyx()

  return report({
    outcome: {
      ...rest,
      state: 'done',
      steps: [
        ...rest.steps,
        {
          step: 'restart',
          state: 'done',
          seconds: 0,
        },
      ],
    },
  })
}

// eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
export const upgrade = (args: string[]) => upgradeIn({ args })

// root is the Pnyx folder an upgrade with no server pulls into; tests pass their own.
export async function upgradeIn({
  args,
  root = PNYX_ROOT,
}: {
  args: string[]
  root?: string
}): Promise<Record<string, unknown> | string> {
  let values: {
    check?: boolean
    now?: boolean
    stop?: boolean
    hydra?: string
    'event-id'?: string
  }

  try {
    values = parseArgs({
      args,
      options: OPTIONS,
      strict: true,
    }).values
  } catch (error) {
    throw flagError({
      error,
      options: OPTIONS,
    })
  }

  if (values.check) {
    const available = await upgradeAvailable({ root })

    return available === undefined ? {
      upgrade: 'unknown: origin main could not be read',
      help: ['Check the network and the Pnyx folder\'s origin remote'],
    } : available ? {
      upgrade: 'available',
      help: ['Run `pnyx-axi upgrade` to upgrade'],
    } : { upgrade: 'none: Pnyx is up to date' }
  }

  // Hydra can only propose it (owner-only); a worker cannot restart the server under everyone.
  if (workerIdentity()) {
    throw new AxiError(
      'Only the owner can upgrade Pnyx',
      'OWNER_ONLY',
      ['Ask the owner to run `pnyx-axi upgrade` or send /upgrade in Hydra\'s chat'],
    )
  }

  // The server runs this for a terminal; in a terminal no server is up, so nothing is there to stop.
  if (values.stop) {
    return stopUpgrade() ? { stopped: 'upgrade' } : {
      stopped: 'none: the Pnyx server is not pulling, installing, building or checking an upgrade',
      help: ['Ctrl-C stops an upgrade that runs in a terminal; a built upgrade waiting to restart cannot be stopped'],
    }
  }

  const hydraId = values.hydra ?? (requestEnv().PNYX_HYDRA || DEFAULT_HYDRA)

  // Inside the server: the queue /upgrade uses takes it, and the terminal that handed it over reads how far it is.
  if (values['event-id']) {
    const { operation } = await askHost({
      hydraId,
      body: {
        action: 'upgrade',
        id: values['event-id'],
        now: values.now,
      },
    })

    return JSON.stringify(operation)
  }

  return await handOver({
    hydraId,
    now: values.now,
  }) ?? runHere({
    root,
    now: values.now,
  })
}
