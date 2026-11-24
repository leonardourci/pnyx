export const TITAN_ACTOR = 'hydra'

// The Titan page and an unlabelled CLI are usually the owner; workers Othrys runs write as `worker:<task>`.
const OWNER_ACTORS = [
  'web',
  'cli',
]

export const ownerActor = ({ actor }: { actor?: string }) => !actor || OWNER_ACTORS.includes(actor)

export const agentActor = ({ actor }: { actor: string }) => /^(pnyx$|hook:|session:|worker:)/.test(actor)

export const reportActor = ({ actor }: { actor: string }) => actor !== 'pnyx' && agentActor({ actor })
