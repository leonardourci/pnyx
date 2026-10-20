import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { HydraError, type HydraState } from '../core/model.ts'
import { candidates as parseCandidates, defaultLogin, effectiveDispatch, loginFolder, loginVariable, type Account, type Candidate, type EffectiveDispatch, type Harness } from './config.ts'

interface EffectiveQuota {
  status?: string
  effectivePercentRemaining?: number
  runway?: { status?: string }
  selection?: { status?: string; spendPriority?: number }
}
interface QuotaState { status?: string; authStatus?: string; stale?: boolean }
interface ModelQuota {
  provider: string
  id: string
  label?: string
  effective?: EffectiveQuota
  state?: QuotaState
}
interface ProviderQuota {
  provider: string
  notSetUp?: boolean
  state?: QuotaState
  quotaSemantics?: { effectiveAvailability?: (EffectiveQuota & { scope?: string })[] }
}
export interface QuotaReading {
  auth: 'usable' | 'signed-out' | 'unknown'
  models?: ModelQuota[]
  effective?: EffectiveQuota
}
export type ReadQuota = ({ account }: { account: Account }) => QuotaReading
export interface DispatchChoice {
  rule: string
  candidate: Candidate
  account: string
  provider: Harness
  folder: string
  reason: string
}

const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR$|OPENAI_|CODEX_HOME$|CODEX_API_KEY$)/

export function accountEnvironment({ account, env = process.env }: {
  account: Account
  env?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const { provider } = account
  const variable = loginVariable({ provider })

  // Naming the default folder explicitly is not the default login: Claude Code then looks for other credentials.
  if (!env[variable] && loginFolder({ account }) === defaultLogin({ provider, env })) {
    return env
  }

  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !AUTH_ENV.test(key))),
    [variable]: loginFolder({ account }),
  }
}

export function readQuota({ account }: { account: Account }): QuotaReading {
  if (!existsSync(loginFolder({ account }))) {
    return { auth: 'signed-out' }
  }

  const run = ({ command }: { command?: string }): unknown => JSON.parse(execFileSync('quota-axi', [
    ...(command ? [command] : []), '--provider', account.provider, '--profile-only', '--no-credential-refresh', '--full', '--json',
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: accountEnvironment({ account }) }))
  let reading: QuotaReading = { auth: 'unknown' }

  try {
    const report = run({}) as { providers?: ProviderQuota[] }
    const row = report.providers?.find(p => p.provider === account.provider)
    const state = row?.state
    reading = {
      auth: row?.notSetUp || state?.authStatus === 'unusable' || (!state?.authStatus && state?.status === 'auth_required') ? 'signed-out'
        : state?.authStatus === 'usable' || state?.authStatus === 'expired_refreshable' ? 'usable' : 'unknown',
      effective: !state?.stale ? row?.quotaSemantics?.effectiveAvailability?.find(scope => scope.scope === 'all_models') : undefined,
    }
  } catch { /* Missing quota evidence is usable, with uncertainty recorded. */ }

  if (reading.auth === 'signed-out') {
    return reading
  }

  try {
    const report = run({ command: 'models' }) as { models?: ModelQuota[] }
    reading.models = report.models?.filter(row => row.provider === account.provider)

    if (reading.models?.some(row => row.state?.authStatus === 'unusable' || (!row.state?.authStatus && row.state?.status === 'auth_required'))) {
      reading.auth = 'signed-out'
    }
  } catch { /* Harness defaults remain usable when quota-axi is unavailable. */ }

  return reading
}

const FALLBACK_MODELS: Record<Harness, string[]> = {
  claude: ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
}

function nativeModel({ candidate, rows }: {
  candidate: Candidate
  rows?: ModelQuota[]
}): ModelQuota | undefined {
  const id = candidate.model

  return rows?.find(row => row.id === id || (candidate.harness === 'claude' && id && ['opus', 'sonnet', 'haiku', 'fable'].includes(id) && row.id.startsWith(`claude-${id}-`)))
}

function exhausted({ effective }: { effective?: EffectiveQuota }): boolean {
  return effective?.runway?.status === 'exhausted_now' || (effective?.status === 'known' && effective.effectivePercentRemaining !== undefined && effective.effectivePercentRemaining <= 0)
}

export function chooseCandidate({ config, rule = 'default', task, project, harness, quota = readQuota, offers }: {
  config: EffectiveDispatch
  rule?: string
  task: string
  project?: string
  harness?: string
  quota?: ReadQuota
  offers?: Partial<Record<Harness, string[]>>
}): DispatchChoice {
  const { dispatch, accounts } = config
  const candidates = rule === 'default' ? dispatch.default : Object.hasOwn(dispatch.rules, rule) ? dispatch.rules[rule]!.candidates : undefined

  if (!candidates) {
    throw new HydraError({ message: `no heads dispatch rule ${rule}`, code: 'NOT_FOUND', help: ['Run `pnyx-axi rule list`; Hydra must choose a rule for the task'] })
  }

  if (harness && harness !== 'claude' && harness !== 'codex') {
    throw new HydraError({ message: `unknown harness: ${harness}`, code: 'VALIDATION_ERROR' })
  }

  if (!dispatch.main || !Object.hasOwn(accounts, dispatch.main)) {
    throw new HydraError({ message: 'heads dispatch needs a registered main account', code: 'NO_ACCOUNTS', help: ['Run `pnyx-axi rule init --shared`, then edit the shared accounts and account order'] })
  }

  const readings = new Map<string, QuotaReading>()
  const evidence = new Set<string>()
  const choices: { choice: Omit<DispatchChoice, 'reason'>; priority: number; tie: string }[] = []
  const overrides = project ? dispatch.projects[project] : undefined

  for (const candidate of candidates) {
    if (harness && candidate.harness !== harness) {
      continue
    }

    const available = offers?.[candidate.harness]

    const hasModel = !candidate.model || available?.includes(candidate.model)

    if (offers && (!available?.length || !hasModel)) {
      evidence.add(`${candidate.harness}/${candidate.model}: not offered`)
      continue
    }

    const override = overrides?.[candidate.harness]
    const order = override?.length ? override : dispatch.workers[candidate.harness] ?? []

    if (!order.length) {
      evidence.add(`${candidate.harness}: no worker accounts listed`)
    }

    for (const key of order) {
      const account = Object.hasOwn(accounts, key) ? accounts[key] : undefined

      if (!account || account.provider !== candidate.harness) {
        throw new HydraError({ message: `account ${key} is not registered for ${candidate.harness}`, code: 'NO_ACCOUNTS' })
      }

      const reading = readings.get(key) ?? quota({ account })
      readings.set(key, reading)

      if (reading.auth === 'signed-out') {
        throw new HydraError({ message: `account ${key} is signed out; start stopped`, code: 'ACCOUNT_SIGNED_OUT', help: [`Sign in to ${loginFolder({ account })}, then retry; tell the owner if sign-in is needed`] })
      }

      const model = nativeModel({ candidate, rows: reading.models })
      const knownModel = Boolean(model)
        || FALLBACK_MODELS[candidate.harness].includes(candidate.model ?? '')
      const offered = !candidate.model || offers || knownModel

      if (!offered) {
        evidence.add(`${candidate.harness}/${candidate.model}: not offered`)
        break
      }

      const effective = model?.state?.stale ? undefined : model?.effective ?? reading.effective
      const percent = effective?.status === 'known' ? effective.effectivePercentRemaining : undefined
      evidence.add(`${key}${candidate.model ? `/${candidate.model}` : ''}: ${percent === undefined ? 'unknown' : `${percent}%`}`)

      if (exhausted({ effective })) {
        continue
      }

      const score = effective?.selection?.status === 'known' ? effective.selection.spendPriority : undefined
      const priority = typeof score === 'number' && Number.isFinite(score) ? score : 0
      const choice = {
        rule, candidate, account: key, provider: account.provider, folder: loginFolder({ account }),
      }
      const tie = createHash('sha256').update(JSON.stringify([task, rule, candidate.harness, candidate.model ?? '', candidate.effort ?? '', candidate.mode ?? '', candidate.fast ?? '', key]))
        .digest('hex')
      choices.push({ choice, priority, tie })
      break
    }
  }

  choices.sort((a, b) => b.priority - a.priority || a.tie.localeCompare(b.tie))
  const chosen = choices[0]?.choice

  if (!chosen) {
    throw new HydraError({ message: `no usable candidates for rule ${rule}; start stopped: ${[...evidence].join('; ')}`, code: 'DISPATCH_EXHAUSTED', help: ['Tell the owner; Pnyx never switches to a weaker rule or an unlisted account'] })
  }

  return { ...chosen, reason: `${rule}: ${chosen.candidate.model ?? `${chosen.provider} default`} on ${chosen.account}; ${[...evidence].sort().join('; ')}; selected by spendPriority (unknown = 0), task hash breaks ties` }
}

export function dispatchTask({ hydraId, state, task, rule, project, harness, offers }: {
  hydraId: string
  state: HydraState
  task: string
  rule?: string
  project?: string
  harness?: string
  offers?: Partial<Record<Harness, string[]>>
}): DispatchChoice {
  return chooseCandidate({
    config: effectiveDispatch({ hydraId, state }), task, rule, project, harness, offers,
  })
}

export function validateChoice({ value, config, project }: {
  value: unknown
  config: EffectiveDispatch
  project?: string
}): DispatchChoice {
  const sent = value as DispatchChoice | null
  const account = sent && Object.hasOwn(config.accounts, sent.account)
    ? config.accounts[sent.account] : undefined
  // A default login's folder is the server's own, whatever the caller's environment named.
  const choice = sent && account && config.fallback
    ? { ...sent, folder: loginFolder({ account }) } : sent
  const rule = choice?.rule === 'default' ? config.dispatch.default
    : choice && Object.hasOwn(config.dispatch.rules, choice.rule)
      ? config.dispatch.rules[choice.rule]?.candidates : undefined
  const override = project && config.dispatch.projects[project]?.[account?.provider ?? 'claude']
  const order = override?.length ? override : config.dispatch.workers[account?.provider ?? 'claude']

  if (!choice || !account || account.provider !== choice.provider
    || account.provider !== choice.candidate?.harness || loginFolder({ account }) !== choice.folder
    || typeof choice.reason !== 'string' || !order?.includes(choice.account)
    || !rule?.some(candidate => isDeepStrictEqual(candidate, choice.candidate))) {
    throw new HydraError({ message: 'heads dispatch changed or the choice is invalid; retry task start', code: 'VALIDATION_ERROR' })
  }

  parseCandidates({ value: [choice.candidate] })

  return choice
}
