import type { TaskCopy } from '../projects/model.ts'
import type { Card } from '../core/model.ts'
import { git } from '../copies/git.ts'
import { pullRequestLandingSync, type PullRequestLanding } from '../integrations/github/pull-request.ts'

export interface LandingContext {
  refs: string[]
  tip?: string
  base?: string
  repository?: string
  reason?: string
}

function githubRepository({ url }: { url: string }): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1]?.toLowerCase()
}

export function landingContext({ copy }: { copy: TaskCopy }): LandingContext {
  const cwd = copy.path
  const origin = git({
    cwd,
    args: [
      'config',
      '--get',
      'remote.origin.url',
    ],
  })
  let base = copy.base?.replace(
    /^origin\//,
    '',
  )

  const context: LandingContext = {
    refs: [],
    base,
  }

  if (origin.ok) {
    context.repository = githubRepository({ url: origin.out })

    if (!base) {
      const refreshed = git({
        cwd,
        args: [
          'fetch',
          '--quiet',
          'origin',
        ],
      })
      const identified = git({
        cwd,
        args: [
          'remote',
          'set-head',
          'origin',
          '--auto',
        ],
      })

      if (!refreshed.ok || !identified.ok) {
        context.reason = 'could not identify the default branch; its work was kept'

        return context
      }

      base = git({
        cwd,
        args: [
          'symbolic-ref',
          '--quiet',
          '--short',
          'refs/remotes/origin/HEAD',
        ],
      }).out.replace(
        /^origin\//,
        '',
      )
    }

    const fetched = git({
      cwd,
      args: [
        'fetch',
        '--quiet',
        'origin',
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ],
    })

    if (!fetched.ok) {
      context.reason = 'could not fetch the intended base; its work was kept'

      return context
    }
  }

  if (!base) {
    context.reason = 'could not identify the intended base; its work was kept'

    return context
  }

  context.base = base
  let ref = `refs/heads/${base}`
  context.refs = [base]

  if (origin.ok) {
    ref = `refs/remotes/origin/${base}`
    context.refs = [`origin/${base}`]
  }

  const tip = git({
    cwd,
    args: [
      'rev-parse',
      '--verify',
      `${ref}^{commit}`,
    ],
  })

  if (!tip.ok) {
    context.reason = 'could not read the intended base; its work was kept'

    return context
  }

  context.tip = tip.out

  return context
}

export function provesLanding({
  copy,
  head,
  context,
  url,
  landing,
}: {
  copy: TaskCopy
  head: string
  context: LandingContext
  url?: string
  landing?: PullRequestLanding
}): boolean {
  if (!context.tip || context.reason) {
    return false
  }

  const ancestor = ({
    before,
    after,
  }: {
    before: string
    after: string
  }) =>
    git({
      cwd: copy.path,
      args: [
        'merge-base',
        '--is-ancestor',
        before,
        after,
      ],
    }).ok

  if (ancestor({
    before: head,
    after: context.tip,
  })) {
    return true
  }

  const pr = url && /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(url)

  if (!pr || !landing || !context.repository) {
    return false
  }

  const sameRepository = pr[1]!.toLowerCase() === context.repository
  const sameBranch = Boolean(copy.branch) && landing.branch === copy.branch
  const sameBase = landing.base === context.base

  if (!sameRepository || !sameBranch || !sameBase) {
    return false
  }

  const mergeReachedBase = ancestor({
    before: landing.merge,
    after: context.tip,
  })

  if (!mergeReachedBase) {
    return false
  }

  // GitHub keeps the PR head ref after deleting the source branch.
  if (!git({
    cwd: copy.path,
    args: [
      'cat-file',
      '-e',
      `${landing.head}^{commit}`,
    ],
  }).ok) {
    if (!git({
      cwd: copy.path,
      args: [
        'fetch',
        '--quiet',
        'origin',
        `refs/pull/${pr[2]}/head`,
      ],
    }).ok
      || git({
        cwd: copy.path,
        args: [
          'rev-parse',
          'FETCH_HEAD',
        ],
      }).out !== landing.head) {
      return false
    }
  }

  return ancestor({
    before: head,
    after: landing.head,
  })
}

export function landedWork({
  card,
  copy,
  head,
}: {
  card: Card
  copy: TaskCopy
  head: string
}): {
  landed: boolean
  refs: string[]
  reason?: string
} {
  const context = landingContext({ copy })

  if (provesLanding({
    copy,
    head,
    context,
  })) {
    return {
      landed: true,
      refs: context.refs,
    }
  }

  if (context.tip && !context.reason) {
    for (const link of card.links.filter(link => link.kind === 'github_pr' && link.state === 'merged')) {
      const landing = pullRequestLandingSync({ url: link.url })

      if (provesLanding({
        copy,
        head,
        context,
        url: link.url,
        landing,
      })) {
        return {
          landed: true,
          refs: context.refs,
        }
      }
    }
  }

  return {
    landed: false,
    refs: context.refs,
    reason: context.reason,
  }
}
