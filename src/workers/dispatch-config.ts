import { copyFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HydraError } from '#store/errors.ts'
import type { AgentConfig } from './model.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import type { HydraEvent } from '#app/model.ts'
import { readLog } from '#app/event-log.ts'
import { pnyxHome, privateDir, withRegistryLock, writeDurably } from '#store/storage.ts'
import { candidateIssues, checkDispatch, mergePatch, type DispatchDocument } from './dispatch-check.ts'

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
export interface EffectiveDispatch {
  dispatch: HeadsDispatch
  accounts: Record<string, Account>
  // Set when the accounts are the harnesses' default logins, whose folders follow each process's environment.
  fallback?: true
}

type Fields = Record<string, unknown>

export function configPath({ accounts = false }: { accounts?: boolean } = {}): string {
  return join(
    pnyxHome(),
    'config',
    accounts ? 'hydra-accounts.json' : 'hydra-heads-dispatch.json',
  )
}

// One line per applied change; its length is the document's revision.
export const changesPath = () => join(
  pnyxHome(),
  'config',
  'dispatch-changes.jsonl',
)

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
export function readTemplate({ accounts = false }: { accounts?: boolean } = {}): Fields {
  return JSON.parse(readFileSync(
    templatePath({ accounts }),
    'utf8',
  )) as Fields
}

export function templateRules(): Pick<HeadsDispatch, 'rules' | 'default'> {
  const template = readTemplate() as Partial<HeadsDispatch>

  return {
    rules: template.rules ?? {},
    default: template.default ?? [],
  }
}

export function templateAccounts(): { accounts: Record<string, Account> } {
  const template = readTemplate({ accounts: true }) as { accounts: Record<string, Account> }

  for (const account of Object.values(template.accounts)) {
    const folder = process.env[loginVariable({ provider: account.provider })]

    if (folder) {
      account.folder = folder
    }
  }

  return template
}

export function onTemplate(): boolean {
  return !existsSync(configPath()) && !existsSync(configPath({ accounts: true }))
}

export function invalid({ message }: { message: string }): never {
  throw new HydraError({
    message,
    code: 'VALIDATION_ERROR',
  })
}

export function candidates({ value }: { value: unknown }): Candidate[] {
  const [issue] = candidateIssues({ value })

  if (issue) {
    invalid({ message: issue.problem })
  }

  return value as Candidate[]
}

export function readConfig({ path }: { path: string }): Fields {
  try {
    const value: unknown = JSON.parse(readFileSync(
      path,
      'utf8',
    ))

    return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : invalid({ message: `${path} must hold a JSON object` })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }

    if (error instanceof HydraError) {
      throw error
    }

    return invalid({ message: `cannot read ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : 'file is unreadable'}` })
  }
}

function writeJson({
  path,
  value,
}: {
  path: string
  value: unknown
}): void {
  privateDir({ dir: dirname(path) })
  const temp = `${path}.${randomUUID()}.tmp`
  writeDurably({
    path: temp,
    data: `${JSON.stringify(
      value,
      null,
      2,
    )}\n`,
    flag: 'w',
  })
  renameSync(
    temp,
    path,
  )
}

// ponytail: two renames, not one; a crash between them leaves the accounts file ahead, which the next check reports.
export function writeDocument({ document }: { document: DispatchDocument }): void {
  const {
    accounts,
    ...dispatch
  } = document
  writeJson({
    path: configPath({ accounts: true }),
    value: { accounts },
  })
  writeJson({
    path: configPath(),
    value: dispatch,
  })
}

// Copies the shipped templates into the Pnyx home; an existing file is never touched.
export function initConfig(): {
  dispatch: string
  accounts: string
} {
  const paths = {
    dispatch: configPath(),
    accounts: configPath({ accounts: true }),
  }

  if (!existsSync(paths.dispatch)) {
    writeJson({
      path: paths.dispatch,
      value: readTemplate(),
    })
  }

  if (!existsSync(paths.accounts)) {
    writeJson({
      path: paths.accounts,
      value: templateAccounts(),
    })
  }

  return paths
}

const nonempty = ({ value }: { value: unknown }) => value !== undefined && value !== '' && value !== null
  && (typeof value !== 'object' || Object.keys(value).length > 0)

// An empty section keeps the shipped template's rules and default list.
function compose({
  dispatch,
  accounts,
}: {
  dispatch: Fields
  accounts: Fields
}): unknown {
  const document: Fields = {
    ...templateRules(),
    workers: {},
    projects: {},
  }

  for (const [
    key,
    value,
  ] of Object.entries(dispatch)) {
    if (nonempty({ value })) {
      document[key] = value
    }
  }

  document.accounts = accounts.accounts ?? {}

  return document
}

function storedDocument(): DispatchDocument {
  const document = compose({
    dispatch: readConfig({ path: configPath() }),
    accounts: readConfig({ path: configPath({ accounts: true }) }),
  })
  const errors = checkDispatch({ document }).filter(issue => issue.level === 'error')

  if (errors.length) {
    throw new HydraError({
      message: `heads dispatch is invalid: ${errors.map(issue => `${issue.path} ${issue.problem}`).join('; ')}`,
      code: 'VALIDATION_ERROR',
      help: ['Run `pnyx-axi rule schema`, then fix it with `pnyx-axi rule apply`'],
    })
  }

  return document as DispatchDocument
}

type AgentsEvent = HydraEvent & { type: 'board.agents' }

// A Hydra's old agents, as `rule migrate` used to turn them into rules.
function legacyAgents({ hydraId }: { hydraId: string }): Fields | undefined {
  const agents = readLog({ dir: hydraDir({ hydraId }) })?.events
    .filter((event): event is AgentsEvent => event.type === 'board.agents')
    .at(-1)?.data.agents ?? {}

  const list = ({ agent }: { agent: AgentConfig }): Candidate[] => {
    const candidate: AgentConfig = structuredClone(agent)
    delete candidate.quota

    return [candidate]
  }

  const rules = Object.fromEntries(Object.entries(agents).filter(([key]) => key !== 'default')
    .map(([
      key,
      agent,
    ]) => [
      key,
      {
        when: `Use for ${key} work`,
        candidates: list({ agent }),
      },
    ]))

  if (!Object.keys(agents).length) {
    return undefined
  }

  const legacy: Fields = { rules }

  if (agents.default) {
    legacy.default = list({ agent: agents.default })
  }

  return legacy
}

function sections({ value }: { value: Fields }): Fields {
  return Object.fromEntries(Object.entries(value).filter(([
    , section,
  ]) => nonempty({ value: section })))
}

interface HydraFiles {
  dispatch?: string
  accounts?: string
  legacy?: Fields
  at: number
}

function hydraFiles(): HydraFiles[] {
  return hydraIds().flatMap(hydraId => {
    const dir = hydraDir({ hydraId })
    const dispatch = join(
      dir,
      'heads-dispatch.json',
    )
    const accounts = join(
      dir,
      'accounts.json',
    )
    const files: HydraFiles = {
      at: 0,
    }

    for (const [
      key,
      path,
    ] of [
        [
          'dispatch',
          dispatch,
        ],
        [
          'accounts',
          accounts,
        ],
      ] as const) {
      if (existsSync(path)) {
        files[key] = path
        files.at = Math.max(
          files.at,
          statSync(path).mtimeMs,
        )
      }
    }

    if (!files.dispatch) {
      files.legacy = legacyAgents({ hydraId })
    }

    return files.dispatch || files.accounts || files.legacy ? [files] : []
  })
    .toSorted((
      a,
      b,
    ) => a.at - b.at)
}

// Each Hydra's own dispatch and accounts merge into the shared ones once, the newest last; the shared Hydra pin still wins.
export function mergeHydraFiles(): void {
  if (existsSync(changesPath())) {
    return
  }

  const found = hydraFiles()
  privateDir({ dir: dirname(changesPath()) })

  if (!found.length) {
    writeDurably({
      path: changesPath(),
      data: '',
      flag: 'a',
    })

    return
  }

  const shared = readConfig({ path: configPath() })
  let dispatch: unknown = sections({ value: shared })
  let accounts: unknown = readConfig({ path: configPath({ accounts: true }) })

  for (const files of found) {
    const own = files.dispatch ? readConfig({ path: files.dispatch }) : files.legacy ?? {}
    dispatch = mergePatch({
      target: dispatch,
      patch: sections({ value: own }),
    })
    accounts = mergePatch({
      target: accounts,
      patch: files.accounts ? readConfig({ path: files.accounts }) : {},
    })
  }

  const pinned = (shared.rules as Fields | undefined)?.hydra

  if (pinned) {
    dispatch = mergePatch({
      target: dispatch,
      patch: { rules: { hydra: pinned } },
    })
  }

  for (const path of [
    configPath(),
    configPath({ accounts: true }),
  ]) {
    if (existsSync(path)) {
      copyFileSync(
        path,
        `${path}.before-merge`,
      )
    }
  }

  writeDocument({
    document: compose({
      dispatch: dispatch as Fields,
      accounts: accounts as Fields,
    }) as DispatchDocument,
  })

  for (const files of found) {
    for (const path of [
      files.dispatch,
      files.accounts,
    ]) {
      if (path) {
        renameSync(
          path,
          `${path}.merged`,
        )
      }
    }
  }

  writeDurably({
    path: changesPath(),
    data: `${JSON.stringify({
      v: 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: 'pnyx',
      reason: 'Merged each Hydra’s own heads dispatch and accounts into the shared files',
    })}\n`,
    flag: 'a',
  })
}

export function readDocument(): DispatchDocument {
  if (!existsSync(changesPath())) {
    withRegistryLock({ fn: mergeHydraFiles })
  }

  return storedDocument()
}

// For writers already holding the registry lock.
export function lockedDocument(): DispatchDocument {
  mergeHydraFiles()

  return storedDocument()
}

export function effectiveDispatch(): EffectiveDispatch {
  const {
    accounts: registered,
    ...dispatch
  } = readDocument()

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
  const fallback: HeadsDispatch = {
    ...dispatch,
    workers: {
      ...workers,
      ...dispatch.workers,
    },
  }

  if (main) {
    fallback.main = main
  }

  return {
    dispatch: fallback,
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
