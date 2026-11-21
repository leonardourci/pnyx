import { REPORT_PROGRESS_SKILL, CLI_SKILL } from '#setup/skill-names.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hookStatus } from '#setup/hooks.ts'
import { skillStatus } from '#setup/skills.ts'
import { loadHydra } from '#app/store.ts'
import { onPath } from '#setup/check.ts'
import { COMMON, guard, parse, type Output } from '#app/cli-support.ts'
import { findCard } from '#tasks/push-rules.ts'
import { pullRequestNote } from '#integrations/github/pull-request.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { harvestTranscripts, appendNote } from '#integrations/hooks/harvest.ts'

async function integrations({
  hydraId,
}: {
  hydraId: string
}): Promise<Output> {
  const config = hydraConfig({
    state: loadHydra({ hydraId }).state,
    id: hydraId,
  })
  const hooks = hookStatus()

  return {
    hydraId,
    integrations: [
      {
        name: 'skills',
        status: skillStatus(),
        setup: 'pnyx setup skills',
        docs: `${REPORT_PROGRESS_SKILL} and ${CLI_SKILL} are available in every project or copy through global skill links`,
      },
      {
        name: 'hooks',
        status: hooks === 'current' ? 'ready' : `hook script ${hooks}`,
        setup: 'pnyx setup hooks',
        docs: 'Claude Code and Codex sessions report to the Hydra through them',
      },
      {
        name: 'command',
        status: config.command ? `set: ${config.command}` : 'not set',
        setup: 'Set the Hydra command in Settings',
        docs: 'Started with PNYX_HOME, PNYX_WORKER_HOME, PNYX_HYDRA, PNYX_TASK, PNYX_ROLE, PNYX_TASK_TITLE, PNYX_PROMPT, PNYX_HARNESS and PNYX_FOLDER',
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

export const integrationsCommand = guard({
  handler: ({ args }) => {
    const {
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
      },
      positionals: 0,
    })

    return integrations({
      hydraId,
    })
  },
})

// Collects the notes sources already recorded: the cards' transcripts from where
// the last read stopped, and each linked pull request's title and description.
// ponytail: reads every linked pull request on each run; skip merged ones already noted if hydras grow.
export const harvest = guard({
  handler: async ({ args }) => {
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
    // Read before the write: gh-axi can be slow and must not hold up other writes.
    const prs = await Promise.all(cards.flatMap(c => c.links.filter(l => l.kind === 'github_pr').map(async l => ({
      card: c.id,
      url: l.url,
      note: await pullRequestNote({ url: l.url }),
    }))))

    return await withWriter({
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
          values.card ? `Run \`pnyx card ${cards[0]!.id}\` to see its notes` : "Run `pnyx card <id>` to see a card's notes",
        ]

        return out
      },
    })
  },
})
