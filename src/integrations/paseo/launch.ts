// Starts an agent in a new Paseo terminal by typing its command line there, the
// same way a person would. Pnyx never supervises the process afterwards.
import { execFileSync } from 'node:child_process'
import { BoardError, type AgentConfig } from '../../core/model.ts'

const TIMEOUT = 15000

function run({ command, args }: { command: string; args: string[] }): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message

    throw new BoardError({ message: `${command} ${args[0]} failed: ${detail}`, code: 'LAUNCH_FAILED', help: [`Check that \`${command}\` is installed and its daemon runs`] })
  }
}

// Control characters are typed into a live shell, where its line editor would act on
// them (Ctrl-U erases the line), so they become spaces before quoting.
const quote = ({ text }: { text: string }) => `'${text.replace(/\p{Cc}+/gu, ' ').replace(/'/g, '\'\\\'\'')}'`

// One shell line: the environment, then the harness with the configured flags and
// the first prompt.
export function commandLine({ agent, prompt, env }: {
  agent: AgentConfig
  prompt: string
  env: Record<string, string>
}): string {
  const flags = agent.harness === 'claude'
    ? [...(agent.model ? ['--model', agent.model] : []), ...(agent.effort ? ['--effort', agent.effort] : []), ...(agent.mode ? ['--permission-mode', agent.mode] : [])]
    : [...(agent.model ? ['-m', agent.model] : []), ...(agent.effort ? ['-c', `model_reasoning_effort="${agent.effort}"`] : []), ...(agent.mode === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : agent.mode ? ['-s', agent.mode] : [])]

  return [
    ...Object.entries(env).map(([key, value]) => `${key}=${quote({ text: value })}`),
    agent.harness,
    ...flags.map(text => quote({ text })),
    quote({ text: prompt.replace(/\s+/g, ' ').trim() }),
  ].join(' ')
}

interface QuotaModel {
  provider: string
  id: string
  effective?: { effectivePercentRemaining?: number }
}

// The model with the most runway in the bucket for this harness, or undefined when
// quota-axi cannot tell.
export function quotaModel({ harness, quota }: {
  harness: AgentConfig['harness']
  quota: NonNullable<AgentConfig['quota']>
}): string | undefined {
  try {
    const out = execFileSync('quota-axi', ['models', '--intelligence', quota, '--sort', 'runway', '--json', '--max-age', '5m', '--provider', harness], { encoding: 'utf8', timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'ignore'] })
    const { models = [] } = JSON.parse(out) as { models?: QuotaModel[] }

    return models.find(m => m.provider === harness
      && (m.effective?.effectivePercentRemaining ?? 1) > 0)?.id
  } catch {
    return undefined
  }
}

// A new terminal in the caller's Paseo workspace when it runs inside one.
export function createTerminal({ cwd, name }: { cwd: string; name: string }): string {
  const workspace = process.env.PASEO_WORKSPACE_ID
  const out = run({ command: 'paseo', args: ['terminal', 'create', '--cwd', cwd, '--name', name, '--json', ...(workspace ? ['--workspace', workspace] : [])] })
  let id: unknown

  try {
    id = (JSON.parse(out) as { id?: unknown }).id
  } catch { /* Reported below. */ }

  if (typeof id !== 'string' || !id) {
    throw new BoardError({ message: `paseo terminal create returned no terminal id: ${out.trim()}`, code: 'LAUNCH_FAILED' })
  }

  return id
}

export function killTerminal({ terminal }: { terminal: string }): void {
  try {
    run({ command: 'paseo', args: ['terminal', 'kill', terminal] })
  } catch { /* The launch error is the one to report. */ }
}

export function typeCommand({ terminal, command }: { terminal: string; command: string }): void {
  run({ command: 'paseo', args: ['terminal', 'send-keys', terminal, '-l', '--', command] })
  run({ command: 'paseo', args: ['terminal', 'send-keys', terminal, 'Enter'] })
}
