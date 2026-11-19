export const HYDRA_ACTOR = 'hydra'

// The Hydra page and an unlabelled CLI are usually the owner; workers Pnyx runs write as `worker:<task>`.
export const OWNER_ACTORS = [
  'web',
  'cli',
]

export const ownerActor = ({ actor }: { actor?: string }) => !actor || OWNER_ACTORS.includes(actor)

// Pnyx itself, a hook, a session or a worker: an agent's write, never the owner's or Hydra's.
export const agentActor = ({ actor }: { actor: string }) => /^(pnyx$|hook:|session:|worker:)/.test(actor)

// A worker's or session's message to Hydra is its report, never the owner's words.
export const reportActor = ({ actor }: { actor: string }) => actor !== 'pnyx' && agentActor({ actor })
