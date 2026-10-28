import { promisify } from 'node:util'
import { execFile, spawnSync } from 'node:child_process'
import type { SourceNote } from '#tasks/model.ts'
import { failedChecks, pendingChecks, type LinkState } from '#tasks/delivery/model.ts'

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

  if (status?.state === 'merged' && !await pullRequestLanding({ url })) {
    return undefined
  }

  return status?.state
}

export class MergeRejectedError extends Error {}

export interface PullRequestLanding {
  head: string
  merge: string
  branch?: string
  base?: string
}

export async function pullRequestLanding(
  { url }: { url: string },
): Promise<PullRequestLanding | undefined> {
  if (!pullRequestRef({ url })) {
    return undefined
  }

  const details = await pullRequestDetails({ url })

  return landingFromDetails({ details })
}

function landingFromDetails({ details }: {
  details: PullRequestDetails
}): PullRequestLanding | undefined {
  if (!details.merged || !details.merge) {
    return undefined
  }

  const landing: PullRequestLanding = {
    head: details.head,
    merge: details.merge,
  }

  if (details.branch) {
    landing.branch = details.branch
    landing.base = details.base
  }

  return landing
}

export function pullRequestLandingSync({ url }: { url: string }): PullRequestLanding | undefined {
  const pr = pullRequestRef({ url })

  if (!pr) {
    return undefined
  }

  const result = spawnSync(
    process.env.PNYX_GH_AXI || 'gh-axi',
    [
      'api',
      `/repos/${pr.repo}/pulls/${pr.number}`,
      '--jq',
      '{payload: tojson}',
      '--full',
    ],
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )

  if (result.status !== 0) {
    return undefined
  }

  try {
    const encoded = /^payload: (.+)$/m.exec(result.stdout)?.[1]

    if (!encoded) {
      return undefined
    }

    const details = parsePullRequestDetails({ input: JSON.parse(JSON.parse(encoded) as string) })

    return landingFromDetails({ details })
  } catch {
    return undefined
  }
}

export async function githubApi({ args }: { args: string[] }): Promise<unknown> {
  const { stdout } = await promisify(execFile)(
    process.env.PNYX_GH_AXI || 'gh-axi',
    [
      'api',
      ...args,
      '--jq',
      '{payload: tojson}',
      '--full',
    ],
    {
      encoding: 'utf8',
      timeout: VIEW_TIMEOUT_MS,
    },
  )
  const encoded = /^payload: (.+)$/m.exec(stdout)?.[1]

  if (!encoded) {
    throw new Error('gh-axi returned no API payload')
  }

  return JSON.parse(JSON.parse(encoded) as string) as unknown
}

export interface PullRequestDetails {
  head: string
  branch?: string
  base: string
  merged: boolean
  merge?: string
  open: boolean
  draft: boolean
}

export async function pullRequestDetails({ url }: { url: string }): Promise<PullRequestDetails> {
  const pr = pullRequestRef({ url })

  if (!pr) {
    throw new Error(`not a GitHub pull request: ${url}`)
  }

  return parsePullRequestDetails({ input: await githubApi({ args: [`/repos/${pr.repo}/pulls/${pr.number}`] }) })
}

function parsePullRequestDetails({ input }: { input: unknown }): PullRequestDetails {
  const value = input as {
    head?: {
      sha?: unknown
      ref?: unknown
    }
    base?: { ref?: unknown }
    merged?: unknown
    merge_commit_sha?: unknown
    state?: unknown
    draft?: unknown
  } | null
  const head = value?.head?.sha
  const base = value?.base?.ref
  const merge = value?.merge_commit_sha

  if (typeof head !== 'string' || !/^[a-f0-9]{40,64}$/.test(head)
    || typeof base !== 'string' || !base || typeof value?.merged !== 'boolean'
    || typeof value.draft !== 'boolean' || ![
    'open',
    'closed',
  ].includes(String(value.state))) {
    throw new Error('GitHub pull request metadata is unreadable')
  }

  if (value.merged && (typeof merge !== 'string' || !/^[a-f0-9]{40,64}$/.test(merge))) {
    throw new Error('GitHub merge confirmation has no merge commit')
  }

  return {
    head,
    branch: typeof value.head?.ref === 'string' ? value.head.ref : undefined,
    base,
    merged: value.merged,
    merge: value.merged ? merge as string : undefined,
    open: value.state === 'open',
    draft: value.draft,
  }
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
export async function mergePullRequest({
  url,
  head,
}: {
  url: string
  head?: string
}): Promise<void> {
  const pr = pullRequestRef({ url })

  if (!pr) {
    throw new Error(`not a GitHub pull request: ${url}`)
  }

  if (typeof head !== 'string' || !/^[a-f0-9]{40,64}$/.test(head)) {
    throw new Error('a verified head is required')
  }

  try {
    await githubApi({
      args: [
        'PUT',
        `/repos/${pr.repo}/pulls/${pr.number}/merge`,
        '--field',
        `sha=${head}`,
        '--field',
        'merge_method=merge',
      ],
    })
  } catch (error) {
    const output = (error as Error & {
      stdout?: string
      stderr?: string
    })
    const message = `${output.stdout || ''}\n${output.stderr || ''}`
    const rejected = /HTTP (?:400|401|403|404|405|409|422)\b/.test(message)
      || /^code: (?:FORBIDDEN|AUTH_REQUIRED|NOT_FOUND|VALIDATION_ERROR|GH_NOT_INSTALLED)$/m.test(message)

    if (rejected) {
      throw new MergeRejectedError((error as Error).message)
    }

    throw error
  }
}
