import { copyFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TitanError } from '#store/errors.ts'
import type { AgentConfig } from './model.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import type { TitanEvent } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { eventsOrLegacy } from '#app/event-log.ts'
import { othrysHome, privateDir, withRegistryLock, writeDurably } from '#store/storage.ts'
import { appendJournal, readJournal } from '#store/journal.ts'
import { candidateIssues, checkDispatch, fallbackAccount, HARNESSES, mergePatch, type DispatchChange, type DispatchDocument } from './dispatch-check.ts'

export type Harness = AgentConfig['harness']
export type Candidate = Omit<AgentConfig, 'quota'>
export interface Rule {
  when: string
  candidates: Candidate[]
}
export type AccountOrder = Partial<Record<Harness, string[]>>
export interface TitanDispatch {
  rules: Record<string, Rule>
  default: Candidate[]
  main?: string
  workers: AccountOrder
  projects: Record<string, AccountOrder>
}
export interface Account {
  provider: Harness
  folder: string
  label?: string
}
export interface EffectiveDispatch {
  dispatch: TitanDispatch
  accounts: Record<string, Account>
  // Set when the accounts are the harnesses' default logins, whose folders follow each process's environment.
  fallback?: true
}

type Fields = Record<string, unknown>

export interface ChangeEntry {
  v: 1
  id: string
  at: string
  actor: string
  reason?: string
  digest?: string
  changes?: DispatchChange[]
  receipt?: Output
  // The whole document after this change; the last one logged is the saved heads dispatch.
  document?: DispatchDocument
  // A retry record for a patch that changed nothing; it does not count toward the revision.
  unchanged?: true
}

function configPath({ accounts = false }: { accounts?: boolean } = {}): string {
  return join(
    othrysHome(),
    'config',
    accounts ? 'hydra-accounts.json' : 'hydra-heads-dispatch.json',
  )
}

// The change log is the saved heads dispatch: one line per change, each carrying the whole document.
const changesPath = () => join(
  othrysHome(),
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
function readTemplate({ accounts = false }: { accounts?: boolean } = {}): Fields {
  return JSON.parse(readFileSync(
    templatePath({ accounts }),
    'utf8',
  )) as Fields
}

function templateRules(): Pick<TitanDispatch, 'rules' | 'default'> {
  const template = readTemplate() as Partial<TitanDispatch>

  return {
    rules: template.rules ?? {},
    default: template.default ?? [],
  }
}

function templateAccounts(): { accounts: Record<string, Account> } {
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
  return !committedDocument()
}

export function invalid({ message }: { message: string }): never {
  throw new TitanError({
    message,
    code: 'VALIDATION_ERROR',
  })
}

export function candidates({ value }: { value: unknown }): Candidate[] {
  const [issue] = candidateIssues({ value })

  if (issue) {
    invalid({ message: `${issue.path || '/'} ${issue.problem}` })
  }

  return value as Candidate[]
}

function readConfig({ path }: { path: string }): Fields {
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

    if (error instanceof TitanError) {
      throw error
    }

    return invalid({ message: `cannot read ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : 'file is unreadable'}` })
  }
}

const serialized = ({ value }: { value: unknown }) => `${JSON.stringify(
  value,
  null,
  2,
)}\n`

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
    data: serialized({ value }),
    flag: 'w',
  })
  renameSync(
    temp,
    path,
  )
}

const mirrorFiles = ({ document }: { document: DispatchDocument }) => {
  const {
    accounts,
    ...dispatch
  } = document

  return [
    {
      path: configPath({ accounts: true }),
      value: { accounts },
    },
    {
      path: configPath(),
      value: dispatch,
    },
  ]
}

export function writeDocument({ document }: { document: DispatchDocument }): void {
  for (const file of mirrorFiles({ document })) {
    writeJson(file)
  }
}

function mirrored({ document }: { document: DispatchDocument }): boolean {
  return mirrorFiles({ document }).every(({
    path,
    value,
  }) => {
    try {
      return readFileSync(
        path,
        'utf8',
      ) === serialized({ value })
    } catch {
      // A missing or unreadable file is rewritten like a stale one.
      return false
    }
  })
}

export const readChanges = () => readJournal<ChangeEntry>({
  path: changesPath(),
  readable: ({ entry }) => entry?.v === 1 && typeof entry.id === 'string',
})

// A copy, since the journal keeps the parsed entries for the next read.
const committedDocument = () => structuredClone(readChanges()
  .findLast(entry => entry.document)?.document)

// The durable log line is the commit point: a failed append changes nothing, and the files follow it.
export function commitChange({ entry }: { entry: ChangeEntry }): void {
  appendJournal({
    path: changesPath(),
    entry,
  })

  if (entry.document) {
    writeDocument({ document: entry.document })
  }
}

// Saves the shipped templates as the first change, keeping either file that already exists; a saved document is never replaced.
export function initConfig({ meta }: { meta: Meta }): {
  dispatch: string
  accounts: string
} {
  const paths = {
    dispatch: configPath(),
    accounts: configPath({ accounts: true }),
  }

  withRegistryLock({
    fn: () => {
      mergeTitanFiles()

      if (committedDocument()) {
        return
      }

      commitChange({
        entry: {
          v: 1,
          id: meta.id ?? randomUUID(),
          at: meta.at,
          actor: meta.actor,
          reason: 'Saved the shipped heads dispatch templates',
          document: compose({
            dispatch: existsSync(paths.dispatch)
              ? readConfig({ path: paths.dispatch })
              : readTemplate(),
            accounts: existsSync(paths.accounts)
              ? readConfig({ path: paths.accounts })
              : templateAccounts(),
          }) as DispatchDocument,
        },
      })
    },
  })

  return paths
}

const nonempty = ({ value }: { value: unknown }) => value !== undefined && value !== '' && value !== null
  && (typeof value !== 'object' || Object.keys(value).length > 0)

// Before the first logged document, an empty section keeps the shipped template's rules and default list.
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

const filesDocument = () => compose({
  dispatch: readConfig({ path: configPath() }),
  accounts: readConfig({ path: configPath({ accounts: true }) }),
}) as DispatchDocument

function checked({ document }: { document: unknown }): DispatchDocument {
  const errors = checkDispatch({ document }).filter(issue => issue.level === 'error' && !issue.readable)

  if (errors.length) {
    throw new TitanError({
      message: `heads dispatch is invalid: ${errors.map(issue => `${issue.path} ${issue.problem}`).join('; ')}`,
      code: 'VALIDATION_ERROR',
      help: ['Run `othrys rule schema` for accepted values. Edit the dispatch rules in Settings.'],
    })
  }

  return document as DispatchDocument
}

type AgentsEvent = TitanEvent & { type: 'board.agents' }

// A Titan's old agents, as `rule migrate` used to turn them into rules.
function legacyAgents({ hydraId }: { hydraId: string }): Fields | undefined {
  const agents = eventsOrLegacy({
    hydraId,
    types: ['board.agents'],
  })
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

interface TitanFiles {
  dispatch?: string
  accounts?: string
  legacy?: Fields
  at: number
}

function hydraFiles(): TitanFiles[] {
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
    const files: TitanFiles = {
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

// Each Titan's own dispatch and accounts merge into the shared ones once, the newest last; the shared Titan pin still wins.
function mergeTitanFiles(): void {
  if (existsSync(changesPath())) {
    return
  }

  const found = hydraFiles()

  if (!found.length) {
    appendJournal({ path: changesPath() })

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

  commitChange({
    entry: {
      v: 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: 'othrys',
      reason: 'Merged each Titan’s own heads dispatch and accounts into the shared files',
      document: compose({
        dispatch: dispatch as Fields,
        accounts: accounts as Fields,
      }) as DispatchDocument,
    },
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
}

export function repairDispatchMirrors(): DispatchDocument | undefined {
  const committed = committedDocument()

  if (committed && !mirrored({ document: committed })) {
    writeDocument({ document: committed })
  }

  return committed
}

export function lockedDocument(): DispatchDocument {
  mergeTitanFiles()

  return repairDispatchMirrors() ?? filesDocument()
}

// The saved document with any errors it holds, so a patch can still repair it; readers take effectiveDispatch.
export function savedDocument(): DispatchDocument {
  const committed = committedDocument()

  if (committed) {
    return committed
  }

  const files = filesDocument()

  // A first save logs its document before renaming either file, so files read before that line appears are one pair.
  return committedDocument() ?? files
}

export function effectiveDispatch({
  document = savedDocument(),
}: { document?: unknown } = {}): EffectiveDispatch {
  const {
    accounts: registered,
    ...dispatch
  } = checked({ document })

  if (Object.keys(registered).length) {
    return {
      dispatch,
      accounts: registered,
    }
  }

  // With no registered accounts, Titan and workers run on each harness's own login, as an unconfigured harness does.
  const accounts: Record<string, Account> = Object.fromEntries(HARNESSES
    .filter(provider => existsSync(defaultLogin({ provider })))
    .map(provider => [
      fallbackAccount({ provider }),
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
  const fallback: TitanDispatch = {
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
