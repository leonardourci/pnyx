// Reads a linked pull request's title and description through `gh-axi pr view`.
// Read-only; PNYX_GH_AXI overrides the binary, so tests use a fake one.
import { spawnSync } from 'node:child_process'
import type { SourceNote } from '../../core/model.ts'

const VIEW_TIMEOUT_MS = 30_000
// ponytail: a long description is cut here; raise it if descriptions that long need to stay whole.
const BODY_MAX = 8000
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/

// One `  key: value` field of gh-axi's TOON output; a quoted value is a JSON string.
function field({ out, key }: { out: string; key: string }): string | undefined {
  const line = new RegExp(`^ {2}${key}: (.*)$`, 'm').exec(out)?.[1]

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
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)}…` : text
}

// The pull request as a context note, or null when it is not a GitHub pull request
// URL or gh-axi cannot read it. The ref carries the text, so an edited description
// becomes a new note and the earlier one stays.
export function pullRequestNote({ url }: { url: string }): SourceNote | null {
  const pr = PR_URL.exec(url)

  if (!pr) {
    return null
  }

  const [, owner, repo, number] = pr
  const result = spawnSync(process.env.PNYX_GH_AXI || 'gh-axi', ['pr', 'view', number!, '--repo', `${owner}/${repo}`, '--full'], {
    encoding: 'utf8',
    timeout: VIEW_TIMEOUT_MS,
  })

  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null
  }

  const title = field({ out: result.stdout, key: 'title' })

  if (!title) {
    return null
  }

  const body = description({ body: field({ out: result.stdout, key: 'body' }) ?? '' })
  const text = `Pull request #${number}: ${title}${body ? `\n\n${body}` : ''}`

  return { kind: 'context', source: 'github', text, ref: `pr:${url}:${text}` }
}
