// The "Checks ran for this commit" workflow step:
// GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo PR_NUMBER=<n> node scripts/check-marker.ts
import {
  checkPullRequest,
  type Commit,
  MarkerError,
  type PullRequest,
} from './marker.ts'

// GitHub's commit endpoint lists at most 300 files, so a list that long may be cut short.
const COMMIT_FILES_PAGE = 300

async function github<T>({ endpoint }: { endpoint: string }): Promise<T> {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`,
    {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
    },
  )

  if (!response.ok) {
    throw new MarkerError(`Could not read ${endpoint} from the GitHub API (HTTP ${response.status}), failing closed.`)
  }

  return await response.json() as T
}

async function commit({ sha }: { sha: string }): Promise<Commit> {
  const found = await github<{
    commit: { tree: { sha: string } }
    parents: { sha: string }[]
    files: {
      filename: string
      previous_filename?: string
    }[]
  }>({ endpoint: `commits/${sha}` })
  // A rename counts by both paths, so moving code into a .md file is not Markdown-only.
  const files = found.files.flatMap(file => file.previous_filename ? [
    file.filename,
    file.previous_filename,
  ] : [file.filename])

  return {
    tree: found.commit.tree.sha,
    parents: found.parents.map(parent => parent.sha),
    files: found.files.length < COMMIT_FILES_PAGE ? files : null,
  }
}

async function pullRequestsFor({ sha }: { sha: string }): Promise<PullRequest[]> {
  const found = await github<{
    number: number
    body: string | null
  }[]>({ endpoint: `commits/${sha}/pulls` })

  return found.map(pr => ({
    number: pr.number,
    body: pr.body ?? '',
  }))
}

try {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY || !process.env.PR_NUMBER) {
    throw new MarkerError('Set GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER.')
  }

  const pr = await github<{
    body: string | null
    head: { sha: string }
  }>({ endpoint: `pulls/${process.env.PR_NUMBER}` })

  console.log(await checkPullRequest({
    pullRequest: {
      number: Number(process.env.PR_NUMBER),
      body: pr.body ?? '',
    },
    headSha: pr.head.sha,
    commit,
    pullRequestsFor,
  }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
