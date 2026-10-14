// Catches search.db up (rebuilding it when another version built it) in its own
// process, so indexing the transcripts never blocks the server's event loop.
import { updateIndex } from './index.ts'

updateIndex(process.argv[2]!)
