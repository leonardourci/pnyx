import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { canonical } from '#store/paths.ts'

const GIT_TIMEOUT_MS = 5000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const ROOT_SOURCES = /^(AGENTS\.md|CLAUDE\.md|README(?:\.[^/]+)?)$/i
const SKILL_SOURCE = /^(?:\.agents\/skills|\.claude\/skills|skills)\/.*\.md$/

export const contentHash = ({ text }: { text: string }) => createHash('sha256').update(text)
  .digest('hex')

function git({
  path,
  args,
}: {
  path: string
  args: string[]
}): string | undefined {
  try {
    return execFileSync(
      'git',
      [
        '-C',
        path,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
      },
    ).trimEnd()
  } catch {
    return undefined
  }
}

export function normalizedRemote({
  remote,
  path,
}: {
  remote: string
  path: string
}): string {
  const scp = remote.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/)
  let value = remote

  if (scp && !remote.includes('://') && !isAbsolute(remote)) {
    value = `ssh://${scp[1]}/${scp[2]}`
  }

  try {
    const url = new URL(value)

    if (url.protocol === 'file:') {
      return `file:${canonical({ path: decodeURIComponent(url.pathname) }) ?? url.pathname}`.replace(
        /\/+$/,
        '',
      )
    }

    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${url.pathname.replace(
      /^\/+|\/+$/g,
      '',
    ).replace(
      /\.git$/,
      '',
    )}`
  } catch {
    const local = resolve(
      path,
      remote,
    )

    return `file:${canonical({ path: local }) ?? local}`.replace(
      /\/+$/,
      '',
    )
  }
}

function projectRemote({ path }: { path: string }): string | undefined {
  const names = git({
    path,
    args: ['remote'],
  })?.split('\n')
    .filter(Boolean)
    .sort() ?? []

  return names.includes('origin') ? 'origin' : names[0]
}

export function projectIdentity({ path }: { path: string }) {
  const name = projectRemote({ path })
  const remote = name ? git({
    path,
    args: [
      'remote',
      'get-url',
      name,
    ],
  }) : undefined
  const root = git({
    path,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
  }) || path
  const identity = remote ? `remote:${normalizedRemote({
    remote,
    path,
  })}` : `path:${canonical({ path: root }) ?? root}`

  return {
    id: contentHash({ text: identity }),
    identity,
  }
}

function localSources({
  path,
  prefix = '',
}: {
  path: string
  prefix?: string
}): Record<string, string> {
  const hashes: Record<string, string> = {}
  let entries

  try {
    entries = readdirSync(
      join(
        path,
        prefix,
      ),
      { withFileTypes: true },
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return hashes
    }

    throw error
  }

  for (const entry of entries.sort((
    a,
    b,
  ) => a.name.localeCompare(b.name))) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name

    if (!prefix && !ROOT_SOURCES.test(file)) {
      continue
    }

    if (entry.isDirectory()) {
      if (prefix) {
        Object.assign(
          hashes,
          localSources({
            path,
            prefix: file,
          }),
        )
      }

      continue
    }

    // Git records a symlink itself, not the target outside the project.
    if (!entry.isFile() || (prefix && !file.endsWith('.md'))) {
      continue
    }

    hashes[file] = contentHash({
      text: readFileSync(
        join(
          path,
          file,
        ),
        'utf8',
      ),
    })
  }

  return hashes
}

export function projectSources({ path }: { path: string }) {
  try {
    if (!statSync(path).isDirectory()) {
      return {
        available: false,
        ref: 'project folder unavailable',
        hashes: {},
        fingerprint: '',
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }

    return {
      available: false,
      ref: 'project folder unavailable',
      hashes: {},
      fingerprint: '',
    }
  }

  const remote = projectRemote({ path })
  const remoteHead = remote ? git({
    path,
    args: [
      'symbolic-ref',
      '--quiet',
      `refs/remotes/${remote}/HEAD`,
    ],
  }) : undefined
  const candidates = [
    remoteHead,
    ...(remote ? [
      `refs/remotes/${remote}/main`,
      `refs/remotes/${remote}/master`,
    ] : []),
    'refs/heads/main',
    'refs/heads/master',
  ].filter((ref): ref is string => Boolean(ref))
  const ref = candidates.find(candidate => git({
    path,
    args: [
      'rev-parse',
      '--verify',
      `${candidate}^{commit}`,
    ],
  }))
  const isRepo = git({
    path,
    args: [
      'rev-parse',
      '--git-dir',
    ],
  }) !== undefined

  if (isRepo && !ref) {
    return {
      available: false,
      ref: 'unknown default branch',
      hashes: {},
      fingerprint: '',
    }
  }

  let hashes: Record<string, string> = {}

  if (ref) {
    const tree = git({
      path,
      args: [
        'ls-tree',
        '-rz',
        ref,
      ],
    })

    if (tree === undefined) {
      return {
        available: false,
        ref,
        hashes,
        fingerprint: '',
      }
    }

    for (const entry of tree.split('\0').filter(Boolean)) {
      const match = entry.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/s)

      if (match && (ROOT_SOURCES.test(match[2]!) || SKILL_SOURCE.test(match[2]!))) {
        hashes[match[2]!] = match[1]!
      }
    }
  } else {
    hashes = localSources({ path })

    for (const prefix of [
      '.agents/skills',
      '.claude/skills',
      'skills',
    ]) {
      Object.assign(
        hashes,
        localSources({
          path,
          prefix,
        }),
      )
    }
  }

  hashes = Object.fromEntries(Object.entries(hashes).sort((
    [a],
    [b],
  ) => a.localeCompare(b)))

  return {
    available: true,
    ref: ref ?? 'working folder (no git repository)',
    hashes,
    fingerprint: contentHash({ text: JSON.stringify(hashes) }),
  }
}
