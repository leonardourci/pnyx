import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HydraError, type AgentConfig, type HydraState } from '../core/model.ts'
import { pnyxHome } from '../store/hydra-store.ts'
import { hydraDir } from '../app/home-migration.ts'

export type Harness = AgentConfig['harness']
export type Candidate = Omit<AgentConfig, 'quota'>
export interface Rule {
  when: string
  candidates: Candidate[]
}
export type AccountOrder = Partial<Record<Harness, string[]>>
export interface HeadsDispatch {
  rules: Record<string, Rule>
  default: Candidate[]
  main?: string
  workers: AccountOrder
  projects: Record<string, AccountOrder>
}
export interface Account {
  provider: Harness
  folder: string
}
export interface Accounts { accounts: Record<string, Account> }
export interface EffectiveDispatch {
  dispatch: HeadsDispatch
  accounts: Record<string, Account>
  // Set when the accounts are the harnesses' default logins, whose folders follow each process's environment.
  fallback?: true
}

export function configPath({
  hydraId,
  accounts = false,
  shared = false,
}: {
  hydraId: string
  accounts?: boolean
  shared?: boolean
}): string {
  return shared ? join(
    pnyxHome(),
    'config',
    accounts ? 'hydra-accounts.json' : 'hydra-heads-dispatch.json',
  )
    : join(
      hydraDir({ hydraId }),
      accounts ? 'accounts.json' : 'heads-dispatch.json',
    )
}

// Resolves the same from src/ and dist/, which sit at the same depth.
const TEMPLATES = join(
  import.meta.dirname,
  '..',
  '..',
  'setup',
  'config',
)

function templatePath({ accounts = false }: { accounts?: boolean } = {}): string {
  return join(
    TEMPLATES,
    accounts ? 'hydra-accounts.example.json' : 'hydra-heads-dispatch.example.json',
  )
}

// Unlike owner config, a missing shipped template is a broken install, so this throws instead of reading as empty.
export function readTemplate({ accounts = false }: { accounts?: boolean } = {}): unknown {
  return JSON.parse(readFileSync(
    templatePath({ accounts }),
    'utf8',
  ))
}

export function templateRules(): Pick<HeadsDispatch, 'rules' | 'default'> {
  const template = parseDispatch({ value: readTemplate() })

  return {
    rules: template.rules ?? {},
    default: template.default ?? [],
  }
}

export function onTemplate({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): boolean {
  return !existsSync(configPath({
    hydraId,
    shared: true,
  })) && !existsSync(configPath({ hydraId })) && !Object.keys(state.config?.agents ?? {}).length
}

export function invalid({ message }: { message: string }): never {
  throw new HydraError({
    message,
    code: 'VALIDATION_ERROR',
  })
}

function object({
  value,
  what,
}: {
  value: unknown
  what: string
}): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid({ message: `${what} must be an object` })
  }

  return value as Record<string, unknown>
}

function keys({
  value,
  allowed,
  what,
}: {
  value: Record<string, unknown>
  allowed: string[]
  what: string
}): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))

  if (extra.length) {
    invalid({ message: `${what}: unknown fields ${extra.join(', ')}` })
  }
}

export function name({ value }: { value: string }): string {
  if (!/^[a-z][a-z0-9:._-]{0,79}$/.test(value)) {
    invalid({ message: 'names use lowercase letters, digits, colon, dot, underscore and dash' })
  }

  return value
}

export function candidates({ value }: { value: unknown }): Candidate[] {
  if (!Array.isArray(value)) {
    return invalid({ message: 'candidates must be an array' })
  }

  return value.map(raw => {
    const item = object({
      value: raw,
      what: 'candidate',
    })
    keys({
      value: item,
      allowed: [
        'harness',
        'model',
        'effort',
        'mode',
        'fast',
      ],
      what: 'candidate',
    })

    if (item.harness !== 'claude' && item.harness !== 'codex') {
      invalid({ message: 'candidate harness must be claude or codex' })
    }

    for (const key of [
      'model',
      'effort',
      'mode',
    ]) {
      if (item[key] !== undefined && (typeof item[key] !== 'string' || !/^[\w.:/[\]-]{1,100}$/.test(item[key]))) {
        invalid({ message: `candidate ${key} has characters a harness flag cannot take` })
      }
    }

    if (item.fast !== undefined && typeof item.fast !== 'boolean') {
      invalid({ message: 'candidate fast must be boolean' })
    }

    return item as unknown as Candidate
  })
}

function order({ value }: { value: unknown }): AccountOrder {
  const item = object({
    value,
    what: 'account order',
  })
  keys({
    value: item,
    allowed: [
      'claude',
      'codex',
    ],
    what: 'account order',
  })

  for (const names of Object.values(item)) {
    if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) {
      invalid({ message: 'account order must contain arrays of account names' })
    }

    for (const n of names as string[]) {
      name({ value: n })
    }
  }

  return item as AccountOrder
}

export function parseDispatch({ value }: { value: unknown }): Partial<HeadsDispatch> {
  const item = object({
    value,
    what: 'heads dispatch',
  })
  keys({
    value: item,
    allowed: [
      'rules',
      'default',
      'main',
      'workers',
      'projects',
    ],
    what: 'heads dispatch',
  })
  const result: Partial<HeadsDispatch> = {}

  if (item.rules !== undefined) {
    result.rules = Object.fromEntries(Object.entries(object({
      value: item.rules,
      what: 'rules',
    })).map(([
      key,
      raw,
    ]) => {
      name({ value: key })

      if (key === 'default') {
        invalid({ message: 'default is a separate candidate list, not a named rule' })
      }

      const r = object({
        value: raw,
        what: `rule ${key}`,
      })
      keys({
        value: r,
        allowed: [
          'when',
          'candidates',
        ],
        what: `rule ${key}`,
      })

      if (typeof r.when !== 'string' || !r.when.trim()) {
        invalid({ message: `rule ${key} needs a plain-language when` })
      }

      return [
        key,
        {
          when: r.when,
          candidates: candidates({ value: r.candidates }),
        },
      ]
    }))
  }

  if (item.default !== undefined) {
    result.default = candidates({ value: item.default })
  }

  if (item.main !== undefined && item.main !== '') {
    if (typeof item.main !== 'string') {
      invalid({ message: 'main must be an account name' })
    }

    result.main = name({ value: item.main as string })
  }

  if (item.workers !== undefined) {
    result.workers = order({ value: item.workers })
  }

  if (item.projects !== undefined) {
    result.projects = Object.fromEntries(Object.entries(object({
      value: item.projects,
      what: 'projects',
    })).map(([
      path,
      raw,
    ]) => {
      if (!isAbsolute(path)) {
        invalid({ message: 'project overrides use absolute project paths' })
      }

      return [
        path,
        order({ value: raw }),
      ]
    }))
  }

  return result
}

export function parseAccounts({ value }: { value: unknown }): Accounts {
  const item = object({
    value,
    what: 'accounts file',
  })
  keys({
    value: item,
    allowed: ['accounts'],
    what: 'accounts file',
  })

  return {
    accounts: Object.fromEntries(Object.entries(object({
      value: item.accounts ?? {},
      what: 'accounts',
    })).map(([
      key,
      raw,
    ]) => {
      name({ value: key })
      const a = object({
        value: raw,
        what: `account ${key}`,
      })
      keys({
        value: a,
        allowed: [
          'provider',
          'folder',
        ],
        what: `account ${key}`,
      })

      if (a.provider !== 'claude' && a.provider !== 'codex') {
        invalid({ message: `account ${key} provider must be claude or codex` })
      }

      if (typeof a.folder !== 'string' || (!isAbsolute(a.folder) && !a.folder.startsWith('~/'))) {
        invalid({ message: `account ${key} needs an absolute login folder or ~/path` })
      }

      return [
        key,
        {
          provider: a.provider,
          folder: a.folder,
        },
      ]
    })),
  }
}

export function readConfig({ path }: { path: string }): unknown {
  try {
    return JSON.parse(readFileSync(
      path,
      'utf8',
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }

    return invalid({ message: `cannot read ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : 'file is unreadable'}` })
  }
}

export function writeConfig({
  path,
  value,
  accounts = false,
}: {
  path: string
  value: unknown
  accounts?: boolean
}): void {
  const parsed = accounts ? parseAccounts({ value }) : parseDispatch({ value })
  mkdirSync(
    dirname(path),
    { recursive: true },
  )
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(
    temp,
    `${JSON.stringify(
      parsed,
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  renameSync(
    temp,
    path,
  )
}

export function legacyDispatch({ state }: { state: HydraState }): Partial<HeadsDispatch> {
  const agents = state.config?.agents ?? {}

  const list = ({ agent }: { agent: AgentConfig }): Candidate[] => {
    const {
      quota: _quota,
      ...candidate
    } = agent
    void _quota

    return [candidate]
  }

  return {
    rules: Object.fromEntries(Object.entries(agents).filter(([key]) => key !== 'default')
      .map(([
        key,
        agent,
      ]) => [
        key,
        {
          when: `Use for ${key} work`,
          candidates: list({ agent }),
        },
      ])),
    ...(agents.default ? { default: list({ agent: agents.default }) } : {}),
  }
}

function nonempty({ value }: { value: unknown }): boolean {
  return value !== undefined && value !== '' && (typeof value !== 'object' || value === null || Object.keys(value).length > 0)
}

export function effectiveDispatch({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): EffectiveDispatch {
  const sharedPath = configPath({
    hydraId,
    shared: true,
  })
  const shared = parseDispatch({ value: readConfig({ path: sharedPath }) })
  const path = configPath({ hydraId })
  const local = existsSync(path)
    ? parseDispatch({ value: readConfig({ path }) }) : legacyDispatch({ state })
  const dispatch: HeadsDispatch = {
    ...templateRules(),
    workers: {},
    projects: {},
  }

  for (const key of [
    'rules',
    'default',
    'main',
    'workers',
    'projects',
  ] as const) {
    const chosen = nonempty({ value: local[key] }) ? local[key] : shared[key]

    if (chosen !== undefined) {
      Object.assign(
        dispatch,
        { [key]: chosen },
      )
    }
  }

  const globalPath = configPath({
    hydraId,
    accounts: true,
    shared: true,
  })
  const localPath = configPath({
    hydraId,
    accounts: true,
  })
  const globalAccounts = parseAccounts({ value: readConfig({ path: globalPath }) }).accounts
  const localAccounts = parseAccounts({ value: readConfig({ path: localPath }) }).accounts
  const registered = Object.keys(localAccounts).length ? localAccounts : globalAccounts

  if (Object.keys(registered).length) {
    return {
      dispatch,
      accounts: registered,
    }
  }

  // With no registered accounts, Hydra and workers run on each harness's own login, as an unconfigured harness does.
  const accounts: Record<string, Account> = Object.fromEntries(([
    'claude',
    'codex',
  ] as const)
    .filter(provider => existsSync(defaultLogin({ provider })))
    .map(provider => [
      `${provider}:default`,
      {
        provider,
        folder: defaultLogin({ provider }),
      },
    ]))
  const names = Object.keys(accounts)
  const main = dispatch.main ?? names[0]
  const workers = Object.fromEntries(names.map(key => [
    accounts[key]!.provider,
    [key],
  ]))

  return {
    dispatch: {
      ...dispatch,
      ...(main ? { main } : {}),
      workers: {
        ...workers,
        ...dispatch.workers,
      },
    },
    accounts,
    fallback: true,
  }
}

const DEFAULT_LOGINS: Record<Harness, {
  variable: string
  folder: string
}> = {
  claude: {
    variable: 'CLAUDE_CONFIG_DIR',
    folder: '.claude',
  },
  codex: {
    variable: 'CODEX_HOME',
    folder: '.codex',
  },
}

export function loginVariable({ provider }: { provider: Harness }): string {
  return DEFAULT_LOGINS[provider].variable
}

export function defaultLogin({
  provider,
  env = process.env,
}: {
  provider: Harness
  env?: NodeJS.ProcessEnv
}): string {
  return env[loginVariable({ provider })] || join(
    homedir(),
    DEFAULT_LOGINS[provider].folder,
  )
}

export function loginFolder({ account }: { account: Account }): string {
  return resolve(account.folder.startsWith('~/') ? join(
    homedir(),
    account.folder.slice(2),
  ) : account.folder)
}
