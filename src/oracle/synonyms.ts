// A query word or phrase also matches the other words in its group.
export const SYNONYMS: readonly (readonly string[])[] = [
  [
    'pr',
    'pull request',
  ],
  [
    'deploy',
    'release',
    'ship',
  ],
  [
    'rollback',
    'revert',
  ],
  [
    'issue',
    'ticket',
  ],
]

export const synonymGroup = new Map(
  SYNONYMS.flatMap(group => group.map(term => [
    term,
    group,
  ] as const)),
)
