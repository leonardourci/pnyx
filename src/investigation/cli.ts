import { requireReady } from '../core/dependencies.ts'
import { commit, required, type Output } from '../app/cli-support.ts'
import { sendReply } from '../cli/reply.ts'
import { decideMove, findCard, type Meta } from '../core/decide.ts'
import { declareTask, hydraConfig, roleColumn } from '../core/hydra.ts'
import { HydraError, type LandingRule } from '../core/model.ts'
import { landingLine, taskLanding } from '../landing/rule.ts'
import { loadHydra, type Writer } from '../store/hydra-store.ts'
import { decideBuild, decideReport, decideReportReview, readReport, readReportFile } from './report.ts'

// task report <task> [--file <path>] stores a report, or prints the stored one.
export function reportCommand({
  hydraId,
  ref,
  file,
  meta,
}: {
  hydraId: string
  ref?: string
  file?: string
  meta: Meta
}): Output {
  const task = required({
    value: ref,
    what: 'task id',
  })

  if (file === undefined) {
    const card = findCard({
      state: loadHydra({ hydraId }).state,
      ref: task,
    })
    const report = readReport({
      hydraId,
      card,
    })

    return report === undefined
      ? {
        task: card.id,
        report: 'none: no report stored',
        help: [`Store one with \`pnyx-axi task report ${card.id} --file <path> --hydra ${hydraId}\``],
      }
      : {
        task: card.id,
        id: card.report!.id,
        at: card.report!.at,
        inventory: card.report!.review ?? 'not reviewed',
        report,
      }
  }

  const text = readReportFile({ path: file })

  return commit({
    hydraId,
    meta,
    intent: {
      type: 'task.report',
      card: task,
    },
    decide: ({ state }) => decideReport({
      state,
      ref: task,
      text,
      meta,
    }),
  })
}

// What the investigation's own worker hears when it becomes the build, so its context carries over.
function buildMessage({
  hydraId,
  id,
  rule,
}: {
  hydraId: string
  id: string
  rule?: LandingRule
}): string {
  const lines = [
    `The owner approved building this. Your report stays stored (\`pnyx-axi task report ${id} --hydra ${hydraId}\`).`,
    'Start the build on a fresh branch from the up-to-date default branch, and carry over only the changes the build needs, never investigation scratch.',
  ]

  if (rule) {
    lines.push(landingLine({
      rule,
      hydraId,
      id,
    }))
  }

  return lines.join(' ')
}

// The build is new work: its worker's card goes back to In progress, and one without a worker waits in Queued for Hydra to start it.
function reopen({
  hydraId,
  ref,
  writer,
}: {
  hydraId: string
  ref: string
  writer: Writer
}): void {
  const card = findCard({
    state: writer.state,
    ref,
  })
  const meta = {
    actor: 'pnyx',
    at: new Date().toISOString(),
  }
  const queued = roleColumn({
    columns: hydraConfig({
      state: writer.state,
      id: hydraId,
    }).columns,
    role: 'queued',
  })
  const decision = card.sessionIds?.length
    ? declareTask({
      state: writer.state,
      ref: card.id,
      status: 'working',
      note: 'Building from its investigation',
      meta,
    })
    : decideMove({
      state: writer.state,
      ref: card.id,
      column: queued ?? card.column,
      meta,
    })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

// task build <task> turns an investigation into its build and tells its worker, which keeps the context.
export async function buildCommand({
  hydraId,
  ref,
  meta,
  reply = sendReply,
}: {
  hydraId: string
  ref?: string
  meta: Meta
  reply?: typeof sendReply
}): Promise<Output> {
  const task = required({
    value: ref,
    what: 'task id',
  })
  const receipt = commit({
    hydraId,
    meta,
    intent: {
      type: 'task.kind',
      card: task,
    },
    decide: ({
      state,
      meta: decided,
    }) => decideBuild({
      state,
      ref: task,
      meta: decided,
    }),
    // The card leaves Done before it becomes a build: a build in Done would settle away the copy its worker keeps.
    prepare: ({ writer }) => reopen({
      hydraId,
      ref: task,
      writer,
    }),
  })
  const event = receipt.event as { id?: string } | undefined

  if (!event?.id) {
    return receipt
  }

  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: task,
  })
  const session = card.sessionIds?.[0]

  if (!session) {
    return receipt
  }

  const rule = taskLanding({
    state,
    card,
  })

  try {
    requireReady({
      state,
      card,
    })
    const sent = await reply({
      hydraId,
      request: {
        card: card.id,
        expectedSession: session,
        text: buildMessage({
          hydraId,
          id: card.id,
          rule,
        }),
        actor: 'pnyx',
        id: `build:${event.id}`,
        homes: [],
      },
    })

    return {
      ...receipt,
      worker: sent.state,
    }
  } catch (error) {
    if (!(error instanceof HydraError)) {
      throw error
    }

    return {
      ...receipt,
      worker: `not told: ${error.message}`,
    }
  }
}

export function reportReviewCommand({
  hydraId,
  ref,
  report,
  calls,
  none,
  meta,
}: {
  hydraId: string
  ref?: string
  report?: string
  calls: string[]
  none: boolean
  meta: Meta
}): Output {
  const task = required({
    value: ref,
    what: 'task id',
  })
  const reportId = required({
    value: report,
    what: '--report <report-id>',
  })

  return commit({
    hydraId,
    meta,
    intent: {
      type: 'task.report-reviewed',
      card: task,
    },
    decide: ({ state }) => decideReportReview({
      state,
      ref: task,
      report: reportId,
      calls,
      none,
      meta,
    }),
  })
}
