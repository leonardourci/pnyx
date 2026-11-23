import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { emptyTitan, replayOwned } from '#app/reducer.ts'
import { compactionFiles, compactionPermission, readCommand } from '#titan/compaction-files.ts'
import { recordContext } from '#titan/file-context.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { hydraConfig } from '#titan/config.ts'
import { hydraFiles, taskFiles } from '#store/file-home.ts'

test(
  'compaction reads native records and recorded transcripts without repairing files or granting other tools',
  ({ onTestFinished }) => {
    const home = join(
      process.env.OTHRYS_HOME!,
      "records' $(touch OTHRYS_PWNED)",
    )
    vi.stubEnv(
      'OTHRYS_HOME',
      home,
    )
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const dir = hydraFiles({
      home,
      hydra: 'file-reads',
    })
    const task = taskFiles({
      home,
      hydra: 'file-reads',
      task: 'task-one',
    })
    mkdirSync(
      task,
      { recursive: true },
    )
    const hydraLog = join(
      dir,
      'hydra.log',
    )
    const taskLog = join(
      task,
      'task.log',
    )
    const workerLog = join(
      task,
      'worker.log',
    )
    const transcript = join(
      process.env.TMPDIR!,
      'recorded-agent.jsonl',
    )
    const content = '{"n":1,"at":"2026-11-22T00:00:00Z","by":"owner","t":"config","id":"config"}\n{"partial":'
    writeFileSync(
      hydraLog,
      content,
    )
    writeFileSync(
      taskLog,
      '{"n":1,"t":"created","id":"created"}\n',
    )
    writeFileSync(
      workerLog,
      'needs-you: Which account?\n',
    )
    writeFileSync(
      transcript,
      '{"type":"assistant","message":{"content":"Recorded reply"}}\n',
    )
    symlinkSync(
      process.env.TMPDIR!,
      join(
        dir,
        'tasks',
        'outside',
      ),
    )
    const state = emptyTitan()
    replayOwned({
      state,
      events: [
        {
          v: 1,
          seq: 1,
          id: 'configured',
          at: '2026-11-22T00:00:00Z',
          actor: 'owner',
          cardId: TITAN_CARD,
          type: 'board.configured',
          data: hydraConfig({
            state,
            id: 'file-reads',
          }),
        },
      ],
    })
    state.hydraSessions = ['claude:recorded-agent']
    state.sessions = {
      'claude:recorded-agent': {
        id: 'claude:recorded-agent',
        originCardId: TITAN_CARD,
        taskId: TITAN_CARD,
        attention: [],
        sourceRefs: [],
        agent: {
          provider: 'claude',
          sessionId: 'recorded-agent',
          transcriptPath: transcript,
        },
      },
    }
    mkdirSync(join(
      dir,
      'tasks',
      'old export',
    ))
    mkdirSync(join(
      dir,
      'tasks',
      '.pending-task',
    ))
    const unpublishedTask = join(
      dir,
      'tasks',
      'unpublished-task',
    )
    mkdirSync(unpublishedTask)
    writeFileSync(
      join(
        unpublishedTask,
        'worker.log',
      ),
      'note: Unpublished task\n',
    )
    const paths = compactionFiles({
      hydraId: 'file-reads',
      state,
    })
    expect(paths).toEqual([
      hydraLog,
      taskLog,
      workerLog,
      transcript,
    ])
    const command = readCommand({ path: hydraLog })
    const allow = ({
      tool,
      input,
    }: {
      tool: string
      input: Record<string, unknown>
    }) => compactionPermission({
      paths,
      tool,
      input,
    }).behavior
    expect(allow({
      tool:'Bash',
      input:{ command },
    })).toBe('allow')
    expect(execFileSync(
      'sh',
      [
        '-c',
        command,
      ],
      { encoding: 'utf8' },
    )).toBe(content)
    expect(allow({
      tool:'Command',
      input:{ display: command },
    })).toBe('allow')
    expect(allow({
      tool:'Read',
      input:{
        file_path: taskLog,
        offset: 1,
        limit: 10,
      },
    })).toBe('allow')
    expect(allow({
      tool:'Read',
      input:{ file_path: transcript },
    })).toBe('allow')
    const range = command.replace(
      'cat -- ',
      "sed -n '1,1p' ",
    )
    expect(allow({
      tool:'Bash',
      input:{ command: range },
    })).toBe('allow')
    expect(execFileSync(
      'sh',
      [
        '-c',
        range,
      ],
      { encoding: 'utf8' },
    )).toBe(content.split('\n')[0] + '\n')

    for (const denied of [
      command + '; touch /tmp/untrusted',
      command + ' > /tmp/untrusted',
      'othrys titan history',
      "sed -n '1,1p;w /tmp/untrusted' " + command.slice('cat -- '.length),
    ]) {
      expect(allow({
        tool:'Bash',
        input:{ command: denied },
      })).toBe('deny')
    }

    expect(allow({
      tool:'Read',
      input:{ file_path: '/etc/passwd' },
    })).toBe('deny')
    expect(allow({
      tool:'Write',
      input:{
        file_path: hydraLog,
        content: '',
      },
    })).toBe('deny')
    expect(allow({
      tool:'Bash',
      input:{
        command: readCommand({
          path: join(
            dir,
            'tasks',
            'outside',
            'unrelated',
          ),
        }),
      },
    })).toBe('deny')
    expect(readFileSync(
      hydraLog,
      'utf8',
    )).toBe(content)

    const snapshot = join(
      dir,
      'snapshot.json',
    )
    symlinkSync(
      transcript,
      snapshot,
    )
    expect(compactionFiles({
      hydraId: 'file-reads',
      state,
    })).not.toContain(snapshot)
    unlinkSync(snapshot)
    writeFileSync(
      snapshot,
      '{"v":1,"at":"2026-11-21T00:00:00Z"}\n',
    )
    expect(compactionFiles({
      hydraId: 'file-reads',
      state,
    })).toContain(snapshot)
    const context = recordContext({
      hydraId: 'file-reads',
      task: 'task-one',
    })
    expect(context).toContain(taskLog)
    expect(context).toContain(workerLog)
    const tasks = join(
      dir,
      'tasks',
    )
    const relocated = join(
      dir,
      'relocated',
    )
    renameSync(
      tasks,
      relocated,
    )
    symlinkSync(
      relocated,
      tasks,
    )
    expect(compactionFiles({
      hydraId: 'file-reads',
      state,
    })).not.toContain(taskLog)
  },
)
