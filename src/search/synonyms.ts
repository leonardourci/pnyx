// Our own vocabulary: a query word or phrase in a group also matches the rest of
// its group. Add a group or a word here; bump the version so `search status` shows it.
export const SYNONYMS_VERSION = 1

export const SYNONYMS: readonly (readonly string[])[] = [
  ['pr', 'pull request'],
  ['deploy', 'release', 'ship'],
  ['rollback', 'revert'],
  ['issue', 'ticket'],
]

export const synonymGroup = new Map(
  SYNONYMS.flatMap(group => group.map(term => [term, group] as const)),
)
