// The hidden PR-body line `pnpm verify` writes after build, lint and unit tests pass,
// and the check the "Checks ran for this commit" workflow runs against it.
// Node built-ins only: the workflow runs this without installing anything.
const PREFIX = '<!-- pnyx-checks:v1 '
const SUFFIX = ' -->'
const HINT = 'Run `pnpm verify` on the PR head: it writes the marker only after build, lint and unit tests pass.'
const MAX_MARKDOWN_COMMITS = 20

export class MarkerError extends Error {}

export interface Marker {
  head_sha: string
  head_tree: string
  finished_at: string
}

export interface Commit {
  tree: string
  parents: string[]
  // null when GitHub cut the list short, which never counts as Markdown-only.
  files: string[] | null
}

export interface PullRequest {
  number: number
  body: string
}

export function withMarker({
  body,
  marker,
}: {
  body: string
  marker: Marker
}): string {
  const kept = body.split('\n').filter(line => !line.includes(PREFIX))
    .join('\n')
    .trim()

  return [
    kept,
    `${PREFIX}${JSON.stringify(marker)}${SUFFIX}`,
  ].filter(Boolean).join('\n\n')
}

export function parseMarker({ body }: { body: string }): Marker {
  const count = body.split(PREFIX).length - 1

  if (count === 0) {
    throw new MarkerError(`No checks marker in the PR body. ${HINT}`)
  }

  if (count > 1) {
    throw new MarkerError(`The PR body has ${count} checks markers, expected one. ${HINT}`)
  }

  const start = body.indexOf(PREFIX) + PREFIX.length
  const end = body.indexOf(
    SUFFIX,
    start,
  )
  let value: Partial<Record<keyof Marker, unknown>> | null

  try {
    value = end < 0 ? null : JSON.parse(body.slice(
      start,
      end,
    ))
  } catch {
    value = null
  }

  if (typeof value?.head_sha !== 'string' || typeof value.head_tree !== 'string' || typeof value.finished_at !== 'string') {
    throw new MarkerError(`The checks marker is not a closed line with head_sha, head_tree and finished_at. ${HINT}`)
  }

  return {
    head_sha: value.head_sha,
    head_tree: value.head_tree,
    finished_at: value.finished_at,
  }
}

function testedTree({ body }: { body: string }): string | undefined {
  try {
    return parseMarker({ body }).head_tree
  } catch (error) {
    if (error instanceof MarkerError) {
      return undefined
    }

    throw error
  }
}

// Passes when the marker names the head. Otherwise it walks back from the head while
// each commit changed only Markdown, and passes at the first commit whose tree a marker
// tested: this PR's own (a docs commit or a same-code rebase after the run) or another
// PR's linked to that commit (the same code already checked elsewhere).
export async function checkPullRequest({
  pullRequest,
  headSha,
  commit,
  pullRequestsFor,
}: {
  pullRequest: PullRequest
  headSha: string
  commit({ sha }: { sha: string }): Promise<Commit>
  pullRequestsFor({ sha }: { sha: string }): Promise<PullRequest[]>
}): Promise<string> {
  let own: Marker | undefined
  let ownError: MarkerError | undefined

  try {
    own = parseMarker({ body: pullRequest.body })
  } catch (error) {
    if (!(error instanceof MarkerError)) {
      throw error
    }

    ownError = error
  }

  if (own?.head_sha === headSha) {
    return `Checks passed for ${headSha}.`
  }

  let sha = headSha

  for (let step = 0; step <= MAX_MARKDOWN_COMMITS; step++) {
    const [
      walked,
      linked,
    ] = await Promise.all([
      commit({ sha }),
      pullRequestsFor({ sha }),
    ])
    const after = sha === headSha ? '' : `, and only Markdown changed after ${sha}`

    if (own?.head_tree === walked.tree) {
      return `Checks passed for ${headSha}: the run on ${own.head_sha} tested the same code${after}.`
    }

    const other = linked.find(pr =>
      pr.number !== pullRequest.number && testedTree({ body: pr.body }) === walked.tree)

    if (other) {
      return `Checks passed for ${headSha}: PR #${other.number}'s run tested the same code${after}.`
    }

    if (walked.parents.length === 0 || !walked.files?.every(file => file.endsWith('.md'))) {
      break
    }

    sha = walked.parents[0]
  }

  throw ownError ?? new MarkerError(`The checks marker is for ${own?.head_sha}, but the PR head is ${headSha} and its code changed since. ${HINT}`)
}
