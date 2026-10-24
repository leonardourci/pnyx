import { promisify } from 'node:util'
import { execFile, spawnSync } from 'node:child_process'
import { failedChecks, pendingChecks, type LinkState, type SourceNote } from '../../core/model.ts'

const VIEW_TIMEOUT_MS = 30_000
const BODY_MAX = 8000
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/

// One `  key: value` field of gh-axi's TOON output; a quoted value is a JSON string.
function field({
  out,
  key,
}: {
  out: string
  key: string
}): string | undefined {
  const line = new RegExp(
    `^ {2}${key}: (.*)$`,
    'm',
  ).exec(out)?.[1]

  if (line === undefined) {
    return undefined
  }

  if (!line.startsWith('"')) {
    return line
  }

  try {
    return JSON.parse(line) as string
  } catch {
    return undefined
  }
}

// The description without its collapsed blocks and HTML comments, which hold
// generated evidence and template markers rather than what the change is.
function description({ body }: { body: string }): string {
  const text = body
    .replace(
      /<details>[\s\S]*?<\/details>/g,
      '',
    )
    .replace(
      /<!--[\s\S]*?-->/g,
      '',
    )
    .replace(
      /\n{3,}/g,
      '\n\n',
    )
    .trim()

  return text.length > BODY_MAX ? `${text.slice(
    0,
    BODY_MAX,
  )}…` : text
}

// The pull request as a context note, or null when it is not a GitHub pull request
// URL or gh-axi cannot read it. The ref carries the text, so an edited description
// becomes a new note and the earlier one stays.
export function pullRequestNote({ url }: { url: string }): SourceNote | null {
  const pr = PR_URL.exec(url)

  if (!pr) {
    return null
  }

  const [
    , owner,
    repo,
    number,
  ] = pr
  const result = spawnSync(
    process.env.PNYX_GH_AXI || 'gh-axi',
    [
      'pr',
      'view',
      number!,
      '--repo',
      `${owner}/${repo}`,
      '--full',
    ],
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )

  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null
  }

  const title = field({
    out: result.stdout,
    key: 'title',
  })

  if (!title) {
    return null
  }

  const body = description({
    body: field({
      out: result.stdout,
      key: 'body',
    }) ?? '',
  })
  const text = `Pull request #${number}: ${title}${body ? `\n\n${body}` : ''}`

  return {
    kind: 'context',
    source: 'github',
    text,
    ref: `pr:${url}:${text}`,
  }
}

export async function pullRequestState({ url }: { url: string }): Promise<LinkState | undefined> {
  const status = await pullRequestStatus({ url })

  return status?.state
}

export interface PullRequestLanding {
  head: string
  merge: string
  branch?: string
  base?: string
}

function landingArgs({ url }: { url: string }): string[] | undefined {
  const pr = PR_URL.exec(url)

  return pr ? [
    'api',
    `/repos/${pr[1]}/${pr[2]}/pulls/${pr[3]}`,
    '--jq',
    '.head.sha + " " + (.merge_commit_sha // "") + " " + (.merged|tostring) + " " + .head.ref + " " + .base.ref',
  ] : undefined
}

function parseLanding({ out }: { out: string }): PullRequestLanding | undefined {
  const [
    head,
    merge,
    merged,
    branch,
    base,
  ] = (field({
    out,
    key: 'body',
  }) ?? '').split(' ')

  if (merged !== 'true' || !head || !merge
    || !/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(merge)) {
    return undefined
  }

  const landing: PullRequestLanding = {
    head,
    merge,
  }

  if (branch) {
    landing.branch = branch
  }

  if (base) {
    landing.base = base
  }

  return landing
}

export function pullRequestLandingSync({ url }: { url: string }): PullRequestLanding | undefined {
  const args = landingArgs({ url })

  if (!args) {
    return undefined
  }

  const result = spawnSync(
    process.env.PNYX_GH_AXI || 'gh-axi',
    args,
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )

  return result.status === 0 ? parseLanding({ out: result.stdout }) : undefined
}

export async function pullRequestLanding(
  { url }: { url: string },
): Promise<PullRequestLanding | undefined> {
  const args = landingArgs({ url })

  if (!args) {
    return undefined
  }

  const { stdout } = await promisify(execFile)(
    process.env.PNYX_GH_AXI || 'gh-axi',
    args,
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )

  return parseLanding({ out: stdout })
}

export interface PullRequestChecks {
  summary: string
  failed: number
  pending: number
}

export interface PullRequestStatus {
  state: LinkState
  draft: boolean
  checks: PullRequestChecks
  // Conversation comments and reviews together.
  comments: number
}

// gh-axi's checks line ("3 passed, 1 failed, 1 skipped, 6 total").
function checkCounts({ summary }: { summary: string }): PullRequestChecks {
  return {
    summary: summary.split(' — ')[0]!,
    failed: failedChecks({ checks: summary }),
    pending: pendingChecks({ checks: summary }),
  }
}

export function pullRequestRef({ url }: { url: string }): {
  number: string
  repo: string
} | undefined {
  const pr = PR_URL.exec(url)

  return pr ? {
    number: pr[3]!,
    repo: `${pr[1]}/${pr[2]}`,
  } : undefined
}

// One gh-axi read gives a followed pull request's state, checks and comment count.
export async function pullRequestStatus(
  { url }: { url: string },
): Promise<PullRequestStatus | undefined> {
  const pr = pullRequestRef({ url })

  if (!pr) {
    return undefined
  }

  const { stdout } = await promisify(execFile)(
    process.env.PNYX_GH_AXI || 'gh-axi',
    [
      'pr',
      'view',
      pr.number,
      '--repo',
      pr.repo,
    ],
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )
  const state = field({
    out: stdout,
    key: 'state',
  })

  if (state !== 'open' && state !== 'merged' && state !== 'closed') {
    return undefined
  }

  const fieldCount = ({ key }: { key: string }) => {
    const value = Number.parseInt(field({
      out: stdout,
      key,
    }) ?? '')

    return Number.isNaN(value) ? 0 : value
  }

  return {
    state,
    draft: field({
      out: stdout,
      key: 'draft',
    }) !== 'no',
    checks: checkCounts({
      summary: field({
        out: stdout,
        key: 'checks',
      }) ?? '',
    }),
    comments: fieldCount({ key: 'comment_count' }) + fieldCount({ key: 'review_count' }),
  }
}

// Merges with a merge commit, so every commit of the pull request stays on the base branch.
export async function mergePullRequest({ url }: { url: string }): Promise<void> {
  const pr = pullRequestRef({ url })

  if (!pr) {
    throw new Error(`not a GitHub pull request: ${url}`)
  }

  await promisify(execFile)(
    process.env.PNYX_GH_AXI || 'gh-axi',
    [
      'pr',
      'merge',
      pr.number,
      '--repo',
      pr.repo,
      '--merge',
    ],
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )
}
