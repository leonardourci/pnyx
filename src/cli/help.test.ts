import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusedHelp, helpFlags } from './help.ts'

const HELP = `usage: pnyx-axi task list [--fields <names>]
  Lists the open tasks.
usage: pnyx-axi task source list <id>
  Lists a task's sources.
usage: pnyx-axi task hide|unhide <id> [--event-id <id>]`

test(
  'focused help keeps only the subcommand that was run, matched by its word or an alternative',
  () => {
    assert.equal(
      focusedHelp({
        help: HELP,
        command: 'task',
        sub: 'list',
      }),
      'usage: pnyx-axi task list [--fields <names>]\n  Lists the open tasks.\n',
      'task list --help leaves out task source list',
    )
    assert.equal(
      focusedHelp({
        help: HELP,
        command: 'task',
        sub: 'unhide',
      }),
      'usage: pnyx-axi task hide|unhide <id> [--event-id <id>]\n',
    )
    assert.equal(
      focusedHelp({
        help: HELP,
        command: 'task',
        sub: 'bogus',
      }),
      HELP,
      'an unknown subcommand keeps the whole help',
    )
    assert.deepEqual(
      helpFlags({ help: HELP }),
      [
        '--fields',
        '--event-id',
      ],
    )
  },
)
