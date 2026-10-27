export const REVIEW_CHECKLISTS = [
  'review-code',
  'audit-tests',
  'deslop',
] as const
export type Review = typeof REVIEW_CHECKLISTS[number]
export type Kind = 'docs' | 'skill text' | 'tests' | 'UI' | 'back-end'
type TestScope = 'none' | 'changed' | 'skills' | 'full'
type Groups = Partial<Record<Kind, string[]>>

interface Requirements {
  reviews: readonly Review[]
  tests: TestScope
}

interface Selection extends Requirements {
  groups: Groups
  changedTests: string[]
  why: string
}

const FULL_CHECKS: Requirements = {
  reviews: REVIEW_CHECKLISTS,
  tests: 'full',
}
const MECHANICAL_CHECKS: Requirements = {
  reviews: ['deslop'],
  tests: 'full',
}
const CHECKS_BY_KIND: Record<Kind, Requirements> = {
  docs: {
    reviews: ['deslop'],
    tests: 'none',
  },
  'skill text': {
    reviews: ['deslop'],
    tests: 'skills',
  },
  tests: {
    reviews: ['audit-tests'],
    tests: 'changed',
  },
  UI: FULL_CHECKS,
  'back-end': FULL_CHECKS,
}
const TEST_SCOPE_ORDER: readonly TestScope[] = [
  'full',
  'skills',
  'changed',
  'none',
]
const MECHANICAL_REASON = 'declared mechanical change: deslop and the full suite'
const FULL_REASON = 'code or an unknown change scope requires all reviews and the full suite'
const MIXED_REASON = 'requirements are the union of the changed kinds; skill text runs skill readers, tests run changed files, docs need no checks'

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

  if (path.startsWith('web/')) {
    return 'UI'
  }

  return 'back-end'
}

function groupPaths({ paths }: { paths: readonly string[] | null | undefined }): Groups {
  const groups: Groups = {}

  if (!paths) {
    return groups
  }

  for (const path of paths) {
    const kind = changeKind({ path })
    const group = groups[kind]

    if (group) {
      group.push(path)
    } else {
      groups[kind] = [path]
    }
  }

  return groups
}

function unionRequirements({ paths }: { paths: readonly string[] }): Requirements {
  const reviews = new Set<Review>()
  const testScopes = new Set<TestScope>()

  for (const path of paths) {
    const required = CHECKS_BY_KIND[changeKind({ path })]

    for (const review of required.reviews) {
      reviews.add(review)
    }

    testScopes.add(required.tests)
  }

  let tests: TestScope = 'none'

  for (const scope of TEST_SCOPE_ORDER) {
    if (testScopes.has(scope)) {
      tests = scope
      break
    }
  }

  return {
    reviews: REVIEW_CHECKLISTS.filter(review => reviews.has(review)),
    tests,
  }
}

export function requiredChecks({
  paths,
  mechanical = false,
}: {
  paths: readonly string[] | null | undefined
  mechanical?: boolean
}): Selection {
  const groups = groupPaths({ paths })
  let changedTests: string[] = []

  if (groups.tests) {
    changedTests = groups.tests
  }

  if (mechanical) {
    return {
      ...MECHANICAL_CHECKS,
      groups,
      changedTests,
      why: MECHANICAL_REASON,
    }
  }

  if (!paths || paths.length === 0 || groups.UI || groups['back-end']) {
    return {
      ...FULL_CHECKS,
      groups,
      changedTests,
      why: FULL_REASON,
    }
  }

  return {
    ...unionRequirements({ paths }),
    groups,
    changedTests,
    why: MIXED_REASON,
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
