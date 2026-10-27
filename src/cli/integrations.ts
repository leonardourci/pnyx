import { REPORT_PROGRESS_SKILL, CLI_SKILL, HYDRA_SKILLS } from '../integrations/skills/names.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydraConfig } from '../core/hydra.ts'
import { hookStatus } from '../integrations/hooks/install.ts'
import { skillSource, skillStatus } from '../integrations/skills/install.ts'
import { paseoStatus } from '../integrations/paseo/launch.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { loadHydra } from '../app/store.ts'
import { onPath } from '../setup/check.ts'
import { COMMON, guard, parse, type Output } from './commands.ts'

export async function integrations({
  hydraId,
  url,
  connect,
}: {
  hydraId: string
  url?: string
  connect?: Connect
}): Promise<Output> {
  const config = hydraConfig({
    state: loadHydra({ hydraId }).state,
    id: hydraId,
  })
  const hooks = hookStatus()
  const paseo = await paseoStatus({
    url,
    connect,
  }).then(
    () => 'running',
    (error: Error) => `not running: ${error.message}`,
  )
  const home = config.hydra.kind === 'firstmate' ? config.hydra.home : undefined
  const skills = home ? HYDRA_SKILLS.map(name => ({
    name,
    path: join(
      home,
      '.agents',
      'skills',
      name,
      'SKILL.md',
    ),
  })) : []
  const skillState = !home || skills.some(({ path }) => !existsSync(path)) ? 'missing'
    : skills.every(({
      name,
      path,
    }) => readFileSync(path).equals(readFileSync(skillSource({ name })))) ? 'current' : 'outdated'

  return {
    hydraId,
    integrations: [
      {
        name: 'skills',
        status: skillStatus(),
        setup: 'pnyx-axi setup skills',
        docs: `${REPORT_PROGRESS_SKILL} and ${CLI_SKILL} are available in every project or copy through global skill links`,
      },
      {
        name: 'hooks',
        status: hooks === 'current' ? 'ready' : `hook script ${hooks}`,
        setup: 'pnyx-axi setup hooks',
        docs: 'Claude Code and Codex sessions report to the Hydra through them',
      },
      {
        name: 'paseo',
        status: paseo,
        setup: 'paseo start',
        docs: 'https://paseo.sh',
      },
      {
        name: 'firstmate',
        status: home ? `Hydra ${home}; skills ${skillState}` : 'not configured for this Hydra',
        setup: `pnyx-axi setup hydra --home <firstmate home> --hydra ${hydraId}`,
        docs: 'Run `pnyx-axi hydra homes` to list the Firstmate homes and their Hydras',
      },
      {
        name: 'command',
        status: config.command ? `set: ${config.command}` : 'not set',
        setup: `pnyx-axi hydra set --hydra ${hydraId} --command '<shell command>'`,
        docs: 'Started with PNYX_HOME, PNYX_HYDRA, PNYX_TASK, PNYX_ROLE, PNYX_TASK_TITLE, PNYX_PROMPT, PNYX_HARNESS and PNYX_FOLDER',
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

export const INTEGRATIONS_HELP = `usage: pnyx-axi integrations [--hydra <id>] [--paseo-url <url>]
Lists global skills, hooks, Paseo, Firstmate, the Hydra command and GitHub: whether each is ready and the
command that sets it up. It only reads; nothing is installed or started.
`

export const integrationsCommand = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        'paseo-url': { type: 'string' },
      },
      positionals: 0,
    })

    return integrations({
      hydraId,
      url: values['paseo-url'] as string | undefined,
    })
  },
})
