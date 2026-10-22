import { AsyncLocalStorage } from 'node:async_hooks'

// Set while the server runs a command for its own page, whose actor the server assigns; the server's
// environment may carry the actor of the shell that started it.
export const browserCommand = new AsyncLocalStorage<true>()
