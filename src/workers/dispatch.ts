import { execFile, execFileSync } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { harnessControls } from './controls.ts'
import type { PlanWindow } from './provider.ts'
import type { HydraState } from '../app/model.ts'
import { HydraError } from '../store/errors.ts'
import type { StartOverride } from './model.ts'
import { candidates as parseCandidates, defaultLogin, effectiveDispatch, loginFolder, loginVariable, type Account, type Candidate, type EffectiveDispatch, type Harness, type HeadsDispatch } from './dispatch-config.ts'

interface EffectiveQuota {
  status?: string
  effectivePercentRemaining?: number
  runway?: { status?: string }
  selection?: {
    status?: string
    spendPriority?: number
  }
}
interface QuotaState {
  status?: string
  authStatus?: string
  stale?: boolean
}
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
export type Override = StartOverride
export const OVERRIDE_FIELDS: readonly (keyof Override)[] = [
  'model',
  'effort',
  'mode',
  'fast',
]
export interface DispatchChoice {
  rule: string
  candidate: Candidate
  override?: Override
  ownerOverride?: true
  account: string
  provider: Harness
  folder: string
  reason: string
}

const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR$|OPENAI_|CODEX_HOME$|CODEX_API_KEY$)/

export function accountEnvironment({
  account,
  env = process.env,
}: {
  account: Account
  env?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const { provider } = account
  const variable = loginVariable({ provider })

  // Naming the default folder explicitly is not the default login: Claude Code then looks for other credentials.
  if (!env[variable] && loginFolder({ account }) === defaultLogin({
    provider,
    env,
  })) {
    return env
  }

  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !AUTH_ENV.test(key))),
    [variable]: loginFolder({ account }),
  }
}

const QUOTA_RUN = {
  timeout: 15000,
  maxBuffer: 4 * 1024 * 1024,
}

export function readQuota({ account }: { account: Account }): QuotaReading {
  if (!existsSync(loginFolder({ account }))) {
    return { auth: 'signed-out' }
  }

  const env = accountEnvironment({ account })
  // quota-axi reads one named login folder only through quota; a default login is read as its harness reads it.
  const profileOnly = Boolean(env[loginVariable({ provider: account.provider })])
  const run = ({ command }: { command?: string }): unknown => JSON.parse(execFileSync(
    'quota-axi',
    [
      ...(command ? [command] : []),
      '--provider',
      account.provider,
      ...(!command && profileOnly ? ['--profile-only'] : []),
      '--no-credential-refresh',
      '--full',
      '--json',
    ],
    {
      ...QUOTA_RUN,
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'ignore',
      ],
      env,
    },
  ))
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

interface PlanUsage {
  plan?: string
  windows: PlanWindow[]
}

// The account's plan windows for the composer's usage panel: a cached quota-axi read, so a hover never waits on the vendor.
export async function readUsage({ account }: { account: Account }): Promise<PlanUsage | undefined> {
  if (!existsSync(loginFolder({ account }))) {
    return undefined
  }

  const env = accountEnvironment({ account })

  try {
    const { stdout } = await promisify(execFile)(
      'quota-axi',
      [
        '--provider',
        account.provider,
        // A snapshot answers for every login, and quota-axi refuses a profile read against one.
        ...(env[loginVariable({ provider: account.provider })] && !env.QUOTA_AXI_SNAPSHOT
          ? ['--profile-only'] : []),
        '--no-credential-refresh',
        '--max-age',
        '5m',
        '--json',
      ],
      {
        ...QUOTA_RUN,
        env,
      },
    )
    const row = (JSON.parse(stdout) as {
      providers?: {
        provider: string
        plan?: string
        notSetUp?: boolean
        windows?: {
          label?: string
          percentRemaining?: number
          percentUsed?: number
          resetsAt?: string
        }[]
      }[]
    }).providers?.find(p => p.provider === account.provider)

    return row && !row.notSetUp ? {
      ...(row.plan ? { plan: row.plan } : {}),
      windows: (row.windows ?? []).flatMap(window => {
        const used = window.percentUsed
          ?? (window.percentRemaining === undefined ? undefined : 100 - window.percentRemaining)

        return window.label && used !== undefined ? [
          {
            label: window.label,
            used,
            ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
          },
        ] : []
      }),
    } : undefined
  } catch {
    return undefined
  }
}

// Claude Code takes a 1M-context suffix on any model it lists, such as opus[1m].
const ONE_MILLION = /\[1m\]$/

export const ruleCandidates = ({
  dispatch,
  rule = 'default',
}: {
  dispatch: HeadsDispatch
  rule?: string
}) =>
  rule === 'default' ? dispatch.default
    : Object.hasOwn(
      dispatch.rules,
      rule,
    ) ? dispatch.rules[rule]!.candidates : undefined

export function startCandidates({
  dispatch,
  rule,
  harness,
  override,
  offers,
}: {
  dispatch: HeadsDispatch
  rule?: string
  harness?: string
  override?: Override
  offers?: Partial<Record<Harness, string[]>>
}): Candidate[] | undefined {
  const list = ruleCandidates({
    dispatch,
    rule,
  })

  if (!harness && !override?.model) {
    return list
  }

  const harnesses: Harness[] = [
    'claude',
    'codex',
  ]

  if (harness && !harnesses.includes(harness as Harness)) {
    throw new HydraError({
      message: `unknown harness: ${harness}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return harnesses.filter(provider => {
    if (harness) {
      return provider === harness
    }

    return Boolean(override?.model && offers?.[provider] && offered({
      harness: provider,
      model: override.model,
      available: offers[provider]!,
    }))
  }).map(provider => ({
    ...(list?.find(c => c.harness === provider)
      ?? dispatch.default.find(c => c.harness === provider)),
    harness: provider,
  }))
}

export function overrideAccounts({
  config,
  harness,
  project,
}: {
  config: EffectiveDispatch
  harness: Harness
  project?: string
}): {
  accounts: Record<string, Account>
  order: string[]
} {
  const configured = project ? config.dispatch.projects[project]?.[harness] : undefined
  const order = configured?.length ? configured : config.dispatch.workers[harness]

  if (order?.length) {
    return {
      accounts: config.accounts,
      order,
    }
  }

  const registered = Object.keys(config.accounts)
    .filter(key => config.accounts[key]?.provider === harness)
  const key = `${harness}:default`
  const folder = defaultLogin({ provider: harness })

  if (registered.length || !existsSync(folder)) {
    return {
      accounts: config.accounts,
      order: registered,
    }
  }

  return {
    accounts: {
      ...config.accounts,
      [key]: {
        provider: harness,
        folder,
      },
    },
    order: [key],
  }
}

function nativeModel({
  candidate,
  rows,
}: {
  candidate: Candidate
  rows?: ModelQuota[]
}): ModelQuota | undefined {
  const id = candidate.model?.replace(
    ONE_MILLION,
    '',
  )

  return rows?.find(row => row.id === id || (candidate.harness === 'claude' && id && [
    'opus',
    'sonnet',
    'haiku',
    'fable',
  ].includes(id) && row.id.startsWith(`claude-${id}-`)))
}

function exhausted({ effective }: { effective?: EffectiveQuota }): boolean {
  return effective?.runway?.status === 'exhausted_now' || (effective?.status === 'known' && effective.effectivePercentRemaining !== undefined && effective.effectivePercentRemaining <= 0)
}

const offered = ({
  harness,
  model,
  available,
}: {
  harness: Harness
  model: string
  available: string[]
}) =>
  available.includes(harness === 'claude' ? model.replace(
    ONE_MILLION,
    '',
  ) : model)

const known = ({ row }: { row: EffectiveQuota }): number | undefined => {
  const score = row.selection?.status === 'known' ? row.selection.spendPriority : undefined

  return typeof score === 'number' && Number.isFinite(score) ? score : undefined
}

const named = ({ choice }: { choice: Omit<DispatchChoice, 'reason'> }) =>
  `${choice.provider}/${choice.override?.model ?? choice.candidate.model ?? 'default'} on ${choice.account}`

const described = ({ override }: { override?: Override }) => Object.entries(override ?? {})
  .map(([
    key,
    value,
  ]) => `${key} ${value === true ? 'on' : value === false ? 'off' : value}`)
  .join(', ')

// Known spendPriority ranks first and unknown quota after it; a tie or several unranked choices stop the start.
export function chooseCandidate({
  config,
  rule = 'default',
  project,
  harness,
  override,
  quota = readQuota,
  offers,
}: {
  config: EffectiveDispatch
  rule?: string
  project?: string
  harness?: string
  override?: Override
  quota?: ReadQuota
  offers?: Partial<Record<Harness, string[]>>
}): DispatchChoice {
  const {
    dispatch,
    accounts,
  } = config
  // Only a harness or model chooses; effort, mode and Fast ride on the candidate quota chose.
  const ownerOverride = Boolean(harness || override?.model)
  const candidates = startCandidates({
    dispatch,
    rule,
    harness,
    override,
    offers,
  })

  if (!candidates) {
    throw new HydraError({
      message: `no heads dispatch rule ${rule}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi rule list`; Hydra must choose a rule for the task'],
    })
  }

  if (harness && harness !== 'claude' && harness !== 'codex') {
    throw new HydraError({
      message: `unknown harness: ${harness}`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (!ownerOverride && (!dispatch.main || !Object.hasOwn(
    accounts,
    dispatch.main,
  ))) {
    throw new HydraError({
      message: 'heads dispatch needs a registered main account',
      code: 'NO_ACCOUNTS',
      help: ['Run `pnyx-axi rule init --shared`, then edit the shared accounts and account order'],
    })
  }

  if (!candidates.length && override?.model) {
    throw new HydraError({
      message: `model ${override.model}: not offered by the harness catalogs`,
      code: 'VALIDATION_ERROR',
    })
  }

  const readings = new Map<string, QuotaReading>()
  const evidence = new Set<string>()
  const choices: {
    choice: Omit<DispatchChoice, 'reason'>
    priority?: number
  }[] = []
  const projectOrders = project ? dispatch.projects[project] : undefined

  for (const candidate of candidates) {
    if (harness && candidate.harness !== harness) {
      continue
    }

    const available = offers?.[candidate.harness]
    const model = override?.model ?? candidate.model

    // A harness whose catalog could not be read leaves the model to the harness rather than to a guess.
    const listed = !model
      || offered({
        harness: candidate.harness,
        model,
        available: available ?? [],
      })

    if (available && (!available.length || !listed)) {
      evidence.add(`${candidate.harness}/${model}: not offered`)
      continue
    }

    const projectOrder = projectOrders?.[candidate.harness]
    const explicit = ownerOverride ? overrideAccounts({
      config,
      harness: candidate.harness,
      project,
    }) : undefined
    const listedOrder = projectOrder?.length ? projectOrder : dispatch.workers[candidate.harness]
    const order = explicit?.order ?? listedOrder ?? []
    const logins = explicit?.accounts ?? accounts

    if (!order.length) {
      evidence.add(`${candidate.harness}: no worker accounts listed`)
    }

    for (const key of order) {
      const account = Object.hasOwn(
        logins,
        key,
      ) ? logins[key] : undefined

      if (!account || account.provider !== candidate.harness) {
        throw new HydraError({
          message: `account ${key} is not registered for ${candidate.harness}`,
          code: 'NO_ACCOUNTS',
        })
      }

      const reading = readings.get(key) ?? quota({ account })
      readings.set(
        key,
        reading,
      )

      if (reading.auth === 'signed-out' && ownerOverride) {
        evidence.add(`${key}: signed out`)
        continue
      }

      if (reading.auth === 'signed-out') {
        throw new HydraError({
          message: `account ${key} is signed out; start stopped`,
          code: 'ACCOUNT_SIGNED_OUT',
          help: [`Sign in to ${loginFolder({ account })}, then retry; tell the owner if sign-in is needed`],
        })
      }

      const row = nativeModel({
        candidate: {
          ...candidate,
          ...(model ? { model } : {}),
        },
        rows: reading.models,
      })
      // Every scope that applies bounds the candidate: the whole account, and its model's own window.
      const rows = [
        reading.effective,
        row?.state?.stale ? undefined : row?.effective,
      ]
        .filter((scope): scope is EffectiveQuota => Boolean(scope))
      const percents = rows.flatMap(scope => scope.status === 'known' && scope.effectivePercentRemaining !== undefined ? [scope.effectivePercentRemaining] : [])
      const scores = rows.flatMap(scope => known({ row: scope }) ?? [])
      const priority = scores.length && scores.length === rows.length
        ? Math.min(...scores) : undefined
      evidence.add(`${key}${model ? `/${model}` : ''}: ${percents.length ? `${Math.min(...percents)}%` : 'unknown'}${priority === undefined ? '' : `, spendPriority ${priority}`}`)

      if (!ownerOverride && rows.some(scope => exhausted({ effective: scope }))) {
        continue
      }

      const choice = {
        rule,
        candidate,
        ...(ownerOverride ? { ownerOverride: true as const } : {}),
        ...(override && Object.keys(override).length ? { override } : {}),
        account: key,
        provider: account.provider,
        folder: loginFolder({ account }),
      }
      choices.push({
        choice,
        priority: ownerOverride && candidates.length === 1 ? undefined : priority,
      })
      break
    }
  }

  const ranked = choices
    .flatMap(c => c.priority === undefined ? [] : [
      {
        ...c,
        priority: c.priority,
      },
    ])
    .sort((
      a,
      b,
    ) => b.priority - a.priority)
  const best = ranked[0]
  const tied = best ? ranked.filter(c => c.priority === best.priority) : choices

  if (!choices.length) {
    throw new HydraError({
      message: `no usable candidates for rule ${rule}; start stopped: ${[...evidence].join('; ')}`,
      code: 'DISPATCH_EXHAUSTED',
      help: ['Tell the owner; Pnyx never switches to a weaker rule or an unlisted account'],
    })
  }

  if (tied.length > 1) {
    const harnesses = [...new Set(tied.map(c => c.choice.provider))]
    throw new HydraError({
      message: `rule ${rule} has no single best candidate; start stopped: ${tied.map(c => named({ choice: c.choice })).join(', ')} ${best ? `tie at spendPriority ${best.priority}` : 'all have unknown quota'}; ${[...evidence].sort().join('; ')}`,
      code: 'DISPATCH_TIE',
      help: [
        harnesses.length > 1
          ? `Pick one with --harness ${harnesses.join('|')}, or ask the owner; Pnyx never chooses between equal candidates`
          : `Ask the owner to split rule ${rule} or narrow it to one candidate; Pnyx never chooses between equal candidates`,
      ],
    })
  }

  const chosen = (best ?? tied[0]!).choice
  const how = ownerOverride ? 'owner override; quota does not veto an explicit choice' : best ? 'selected by highest known spendPriority; unknown quota ranks below known' : 'only usable candidate; quota unknown'
  const changed = described({ override: chosen.override })

  return {
    ...chosen,
    reason: `${rule}: ${chosen.override?.model ?? chosen.candidate.model ?? `${chosen.provider} default`} on ${chosen.account}; ${[...evidence].sort().join('; ')}; ${how}${changed ? `; override ${changed}` : ''}`,
  }
}

export function dispatchTask({
  hydraId,
  state,
  rule,
  project,
  harness,
  override,
  offers,
}: {
  hydraId: string
  state: HydraState
  rule?: string
  project?: string
  harness?: string
  override?: Override
  offers?: Partial<Record<Harness, string[]>>
}): DispatchChoice {
  return chooseCandidate({
    config: effectiveDispatch({
      hydraId,
      state,
    }),
    rule,
    project,
    harness,
    override,
    offers,
  })
}

// A Pnyx-hosted agent takes only the values its own setting pickers offer.
export function hostedOverride({
  harness,
  override,
}: {
  harness: Harness
  override?: Override
}): void {
  const controls = harnessControls({
    provider: harness === 'codex' ? 'codex' : 'claude-code',
    hosted: true,
  })

  for (const setting of [
    'effort',
    'mode',
  ] as const) {
    const value = override?.[setting]
    const options = controls?.controls.find(c => c.setting === setting)?.options
      .map(o => o.value) ?? []

    if (value !== undefined && !options.includes(value)) {
      throw new HydraError({
        message: `${harness} has no ${setting} ${value}`,
        code: 'VALIDATION_ERROR',
        help: [`Use one of: ${options.join(', ')}`],
      })
    }
  }
}

export function overrideOf({ value }: { value: unknown }): Override | undefined {
  if (value === undefined) {
    return undefined
  }

  const given = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

  if (!given || Object.keys(given).some(key => !OVERRIDE_FIELDS.includes(key as keyof Override))) {
    throw new HydraError({
      message: 'an override may only set model, effort, mode and fast',
      code: 'VALIDATION_ERROR',
    })
  }

  const [parsed] = parseCandidates({
    value: [
      {
        harness: 'claude',
        ...given,
      },
    ],
  })
  const {
    harness: _harness,
    ...checked
  } = parsed ?? { harness: 'claude' }
  void _harness

  return Object.keys(checked).length ? checked : undefined
}

export function validateChoice({
  value,
  config,
  project,
}: {
  value: unknown
  config: EffectiveDispatch
  project?: string
}): DispatchChoice {
  const sent = value as DispatchChoice | null
  const logins = sent?.ownerOverride === true && sent.candidate?.harness
    ? overrideAccounts({
      config,
      harness: sent.candidate.harness,
      project,
    }) : undefined
  const accounts = logins?.accounts ?? config.accounts
  const account = sent && Object.hasOwn(
    accounts,
    sent.account,
  )
    ? accounts[sent.account] : undefined
  // A default login's folder is the server's own, whatever the caller's environment named.
  const choice = sent && account && config.fallback
    ? {
      ...sent,
      folder: loginFolder({ account }),
    } : sent
  const rule = choice?.rule === 'default' ? config.dispatch.default
    : choice && Object.hasOwn(
      config.dispatch.rules,
      choice.rule,
    )
      ? config.dispatch.rules[choice.rule]?.candidates : undefined
  const projectOrder = project && config.dispatch.projects[project]?.[account?.provider ?? 'claude']
  const order = projectOrder?.length ? projectOrder : config.dispatch.workers[account?.provider ?? 'claude']

  if (!choice || !account || account.provider !== choice.provider
    || account.provider !== choice.candidate?.harness || loginFolder({ account }) !== choice.folder
    || typeof choice.reason !== 'string' || !(logins?.order ?? order)?.includes(choice.account)
    || (choice.ownerOverride !== true && !rule?.some(candidate => isDeepStrictEqual(
      candidate,
      choice.candidate,
    )))) {
    throw new HydraError({
      message: 'heads dispatch changed or the choice is invalid; retry task start',
      code: 'VALIDATION_ERROR',
    })
  }

  parseCandidates({ value: [choice.candidate] })
  const override = overrideOf({ value: choice.override })
  hostedOverride({
    harness: choice.candidate.harness,
    override,
  })

  return {
    ...choice,
    ...(override ? { override } : {}),
  }
}

// The settings a started agent runs with: the candidate's, with any override on top.
export function chosenSettings({ choice }: { choice: DispatchChoice }): Record<string, string> {
  const {
    harness: _harness,
    ...candidate
  } = {
    ...choice.candidate,
    ...choice.override,
  }
  void _harness

  return Object.fromEntries(Object.entries(candidate).filter(([
    , value,
  ]) => value !== undefined)
    .map(([
      key,
      value,
    ]) => [
      key,
      String(value),
    ]))
}
