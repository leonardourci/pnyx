export const HYDRA_ACTOR = 'hydra'

// The Hydra page and an unlabelled CLI are usually the owner; workers Pnyx runs write as `worker:<task>`.
export const OWNER_ACTORS = [
  'web',
  'cli',
]

export const ownerActor = ({ actor }: { actor?: string }) => !actor || OWNER_ACTORS.includes(actor)
