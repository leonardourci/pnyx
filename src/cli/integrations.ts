// Each integration a board can use, whether it is ready, and the command that sets it
// up. Reads only: nothing is installed or started from here.
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { boardConfig } from '../core/hydra.ts'
import { hookStatus } from '../integrations/hooks/install.ts'
import { paseoStatus } from '../integrations/paseo/launch.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { loadBoard } from '../store/board-store.ts'
import { COMMON, guard, parse, type Output } from './commands.ts'
import { HYDRA_SKILL } from './start.ts'

const onPath = ({ name }: { name: string }) =>
  (process.env.PATH ?? '').split(delimiter).some(dir => dir && existsSync(join(dir, name)))

export async function integrations({ board, url, connect }: {
  board: string
  url?: string
  connect?: Connect
}): Promise<Output> {
  const config = boardConfig({ state: loadBoard({ board }).state, id: board })
  const hooks = hookStatus()
  const paseo = await paseoStatus({ url, connect }).then(() => 'running', (error: Error) => `not running: ${error.message}`)
  const home = config.hydra.kind === 'firstmate' ? config.hydra.home : undefined
  const skill = home && join(home, '.agents', 'skills', 'pnyx-hydra', 'SKILL.md')
  const skillState = !skill || !existsSync(skill) ? 'missing'
    : readFileSync(skill).equals(readFileSync(HYDRA_SKILL)) ? 'current' : 'outdated'

  return {
    board,
    integrations: [
      {
        name: 'hooks',
        status: hooks === 'current' ? 'ready' : `hook script ${hooks}`,
        setup: 'pnyx-axi setup hooks',
        docs: 'Claude Code and Codex sessions report to the board through them',
      },
      {
        name: 'paseo',
        status: paseo,
        setup: 'paseo start',
        docs: 'https://paseo.sh',
      },
      {
        name: 'firstmate',
        status: home ? `Hydra ${home}; skill ${skillState}` : 'not this board\'s Hydra',
        setup: `pnyx-axi setup hydra --home <firstmate home> --board ${board}`,
        docs: 'Run `pnyx-axi board homes` to list the Firstmate homes and their boards',
      },
      {
        name: 'command',
        status: config.command ? `set: ${config.command}` : 'not set',
        setup: `pnyx-axi board set --board ${board} --command '<shell command>'`,
        docs: 'Started with PNYX_HOME, PNYX_BOARD, PNYX_TASK, PNYX_ROLE, PNYX_PROMPT, PNYX_HARNESS and PNYX_FOLDER',
      },
      {
        name: 'github',
        status: onPath({ name: 'gh-axi' }) ? 'ready' : 'gh-axi not on PATH',
        setup: 'Install gh-axi',
        docs: 'https://axi.md',
      },
    ],
    help: ['Run a row\'s setup command to enable it'],
  }
}

export const INTEGRATIONS_HELP = `usage: pnyx-axi integrations [--board <id>] [--paseo-url <url>]
Lists hooks, Paseo, Firstmate, the board command and GitHub: whether each is ready and the
command that sets it up. It only reads; nothing is installed or started.
`

export const integrationsCommand = guard({
  handler: ({ args }) => {
    const { values, board } = parse({ args, options: { ...COMMON, 'paseo-url': { type: 'string' } }, positionals: 0 })

    return integrations({ board, url: values['paseo-url'] as string | undefined })
  },
})
