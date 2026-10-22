import { AsyncLocalStorage } from 'node:async_hooks'

// Set while the server runs its page's commands, so an inherited agent PNYX_ACTOR can't replace their actor.
export const browserCommand = new AsyncLocalStorage<true>()
