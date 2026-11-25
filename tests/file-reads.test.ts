import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { readGrant, readCommand } from '#routine-helper/read-grant.ts'
import { recordContext } from '#titan/file-context.ts'
import { hydraFiles, taskFiles } from '#store/file-home.ts'

test(
  'a read grant allows the supplied record and transcript files without repairing them or granting other tools',
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
    const paths = [
      hydraLog,
      taskLog,
      workerLog,
      transcript,
    ]
    const command = readCommand({ path: hydraLog })
    const allow = ({
      tool,
      input,
    }: {
      tool: string
      input: Record<string, unknown>
    }) => readGrant({
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

    const context = recordContext({
      hydraId: 'file-reads',
      task: 'task-one',
    })
    expect(context).toContain(taskLog)
    expect(context).toContain(workerLog)
  },
)
