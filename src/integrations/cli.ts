import { REPORT_PROGRESS_SKILL, CLI_SKILL, HYDRA_SKILLS } from '../setup/skill-names.ts'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hydraConfig } from '../hydra/config.ts'
import { hookStatus } from '../setup/hooks.ts'
import { skillSource, skillStatus } from '../setup/skills.ts'
import { paseoStatus } from './paseo/launch.ts'
import type { Connect } from './paseo/client.ts'
import { loadHydra } from '../app/store.ts'
import { onPath } from '../setup/check.ts'
import { COMMON, guard, parse, type Output } from '../app/cli-support.ts'
import { AxiError } from 'axi-sdk-js'
import { hydraIds } from '../app/home-migration.ts'
import { canonical } from '../store/paths.ts'
import { findCard } from '../tasks/push-rules.ts'
import { pullRequestNote } from './github/pull-request.ts'
import { withWriter } from '../app/writer.ts'
import { drainSpool } from './hooks/ingest.ts'
import { harvestTranscripts, appendNote } from './hooks/harvest.ts'

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

export function firstmateHomes({ base }: { base?: string }): Output {
  const root = base ?? process.env.FIRSTMATE_FACTORY_BASE

  if (!root) {
    throw new AxiError(
      'missing --base',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi hydra homes --base <folder holding the homes>`, or set FIRSTMATE_FACTORY_BASE'],
    )
  }

  let names: string[] = []

  try {
    names = readdirSync(
      root,
      { withFileTypes: true },
    ).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { /* No such folder: no homes. */ }

  const homes = names.map(name => join(
    root,
    name,
  )).filter(path =>
    [
      'state',
      'config',
    ].every(dir => existsSync(join(
      path,
      dir,
    ))) && existsSync(join(
      path,
      'bin',
      'fm-send.sh',
    )))
  let hydras: {
    id: string
    home?: string
  }[] = []

  try {
    hydras = hydraIds().map(id => ({
      id,
      home: loadHydra({ hydraId: id }).state.config?.hydra.home,
    }))
  } catch { /* An unreadable Hydra links no home. */ }

  if (!homes.length) {
    return {
      base: root,
      homes: 'none: no Firstmate homes found',
      help: ['Pass --base <folder holding the homes>'],
    }
  }

  const rows = homes.map(home => {
    const real = canonical({ path: home }) ?? home
    const hydraId = hydras.find(b => b.home === real)?.id

    return {
      home: real,
      hydraId: hydraId ?? 'none',
      ...(hydraId ? {} : { create: `pnyx-axi hydra create --firstmate ${real}` }),
    }
  })

  return {
    base: root,
    homes: rows,
    help: ['Each home gets its own Hydra; run the create command of a home without one'],
  }
}

// Collects the notes sources already recorded: the cards' transcripts from where
// the last read stopped, and each linked pull request's title and description.
// ponytail: reads every linked pull request on each run; skip merged ones already noted if hydras grow.
export const harvest = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        card: { type: 'string' },
      },
      positionals: 0,
    })
    const { state } = loadHydra({ hydraId })
    const cards = values.card ? [
      findCard({
        state,
        ref: values.card as string,
      }),
    ] : Object.values(state.cards)
    // Read before taking the writer lock: gh-axi can be slow and must not block other writers.
    const prs = cards.flatMap(c => c.links.filter(l => l.kind === 'github_pr').map(l => ({
      card: c.id,
      url: l.url,
      note: pullRequestNote({ url: l.url }),
    })))

    return withWriter({
      hydraId,
      fn: ({ writer }) => {
        const spool = drainSpool({ writer })
        const at = new Date().toISOString()
        let notes = harvestTranscripts({
          writer,
          cardIds: cards.map(c => c.id),
          at,
        })

        for (const pr of prs) {
          if (pr.note) {
            notes += appendNote({
              writer,
              cardId: pr.card,
              note: pr.note,
              at,
            })
          }
        }

        const unread = prs.filter(pr => !pr.note).map(pr => pr.url)
        const out: Output = {
          harvested: {
            cards: cards.length,
            notes: notes ? `${notes} new` : 'none: nothing new',
            pullRequests: prs.length - unread.length,
          },
        }

        if (unread.length) {
          out.unread = unread
        }

        if (spool.ingested || spool.rejected) {
          out.spool = spool
        }

        out.help = [
          ...(unread.length ? ['gh-axi could not read those pull requests; check `gh-axi pr view <number> --repo <owner/repo>`'] : []),
          values.card ? `Run \`pnyx-axi card ${cards[0]!.id}\` to see its notes` : "Run `pnyx-axi card <id>` to see a card's notes",
        ]

        return out
      },
    })
  },
})
