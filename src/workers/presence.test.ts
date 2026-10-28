import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession } from './model.ts'
import { terminalPresence } from './presence.ts'

const session: AgentSession = {
  id: 'claude-code:worker',
  agent: {
    provider: 'claude-code',
    sessionId: 'worker',
  },
  originCardId: 'c1',
  taskId: 'c2',
  attention: [],
  sourceRefs: [],
  terminal: {
    pid: '123',
    tty: '/dev/ttys123',
  },
  lastSeen: '2026-10-15T10:00:00Z',
}

test(
  'agent presence uses reboot evidence and verified process ownership, with unknown for errors',
  () => {
    const bootedAt = Date.parse('2026-10-15T09:00:00Z')
    assert.equal(
      terminalPresence({
        session,
        bootedAt,
        run: () => 'ttys123',
      }).state,
      'present',
    )
    assert.equal(
      terminalPresence({
        session: {
          ...session,
          activity: 'ended',
        },
        verifyProcess: true,
        bootedAt,
        run: () => 'ttys123',
      }).state,
      'present',
    )
    assert.equal(
      terminalPresence({
        session: {
          ...session,
          activity: 'ended',
        },
        verifyProcess: true,
        bootedAt,
        run: () => {
          throw Object.assign(
            new Error('exited'),
            { status: 1 },
          )
        },
      }).state,
      'gone',
    )
    assert.equal(
      terminalPresence({
        session,
        bootedAt,
        run: () => 'ttys999',
      }).state,
      'gone',
    )

    for (const current of [
      'ttys999',
      '?',
      '',
    ]) {
      assert.equal(
        terminalPresence({
          session,
          verifyProcess: true,
          bootedAt,
          run: () => current,
        }).state,
        'unknown',
      )
    }

    assert.equal(
      terminalPresence({
        session,
        bootedAt: bootedAt + 7200000,
        run: () => assert.fail('must not probe a reused pid after reboot'),
      }).state,
      'gone',
    )
    assert.equal(
      terminalPresence({
        session,
        bootedAt,
        run: () => {
          throw new Error('unavailable')
        },
      }).state,
      'unknown',
    )
    assert.equal(
      terminalPresence({
        session: {
          ...session,
          terminal: undefined,
        },
        bootedAt,
      }).state,
      'unknown',
    )
  },
)
