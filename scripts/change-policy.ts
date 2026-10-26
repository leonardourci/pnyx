export const REVIEW_CHECKLISTS = [
  'review-code',
  'audit-tests',
  'deslop',
] as const
export type Review = typeof REVIEW_CHECKLISTS[number]
export type Kind = 'docs' | 'skill text' | 'tests' | 'UI' | 'back-end'

export function changeKind({ path }: { path: string }): Kind {
  if (path.startsWith('skills/') && path.endsWith('.md')) {
    return 'skill text'
  }

  if (path.startsWith('docs/') || (path.endsWith('.md') && !path.startsWith('test/fixtures/'))) {
    return 'docs'
  }

  if (path.startsWith('test/') && path.endsWith('.test.ts')) {
    return 'tests'
  }

  return path.startsWith('web/') ? 'UI' : 'back-end'
}

export function changePolicy({
  paths,
  mechanical = false,
}: {
  paths: readonly string[] | null | undefined
  mechanical?: boolean
}): {
  groups: Partial<Record<Kind, string[]>>
  reviews: readonly Review[]
  tests: 'none' | 'skills' | 'changed' | 'full'
  changedTests: string[]
  why: string
} {
  const groups: Partial<Record<Kind, string[]>> = {}

  for (const path of paths ?? []) {
    (groups[changeKind({ path })] ??= []).push(path)
  }

  const full = !paths?.length || !!groups.UI || !!groups['back-end']
  const reviews = mechanical ? ['deslop'] as const : full ? REVIEW_CHECKLISTS
    : REVIEW_CHECKLISTS.filter(name => name === 'audit-tests' ? !!groups.tests
      : name === 'deslop' ? !!groups.docs || !!groups['skill text'] : false)

  return {
    groups,
    reviews,
    tests: mechanical || full ? 'full' : groups['skill text'] ? 'skills'
      : groups.tests ? 'changed' : 'none',
    changedTests: groups.tests ?? [],
    why: mechanical ? 'declared mechanical change: deslop and the full suite'
      : full ? 'code or an unknown change scope requires all reviews and the full suite'
        : 'requirements are the union of the changed kinds; skill text runs skill readers, tests run changed files, docs need no checks',
  }
}

// Declarations in examples and hidden comments do not count as a reviewer's claim.
export function visibleLines({ body }: { body: string }): string[] {
  const lines: string[] = []
  let fence: string | undefined

  for (const line of body.replaceAll(
    /<!--[\s\S]*?(?:-->|$)/g,
    '',
  ).split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]

    if (delimiter) {
      if (!fence) {
        fence = delimiter
      } else if (delimiter[0] === fence[0] && delimiter.length >= fence.length
        && line.trim() === delimiter) {
        fence = undefined
      }

      continue
    }

    if (!fence) {
      lines.push(line)
    }
  }

  return lines
}

export function mechanicalDeclaration({ body }: { body: string }): boolean {
  return visibleLines({ body }).filter(line => /^Change: mechanical \((rename|move)\)\s*$/.test(line)).length === 1
}
