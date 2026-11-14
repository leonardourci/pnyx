import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexProvider } from './codex.ts'
import { inbox } from '#hydra/update-queue.ts'
import { until } from '#test-harness/harness.ts'
import { once } from 'node:events'
import { codexProcesses } from './codex-processes.ts'

const LONG_COMMAND = 'sleep 120'

test(
  'Codex Stop terminates its foreground child and preserves completed background and unrelated children',
  async t => {
  // This process stands in for the app-server; its children are real OS processes.
    const app = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', command => {
      const child = spawn('sh', ['-c', command], {stdio: 'ignore'});
      process.stdout.write(child.pid + '\\n');
    });
  `,
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'pipe',
        ],
      },
    )
    const children: number[] = []
    t.after(() => {
      for (const pid of children) {
        try {
          process.kill(
            pid,
            'SIGKILL',
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }

      app.kill('SIGKILL')
    })

    const launch = async ({ command }: { command: string }) => {
      const output = once(
        app.stdout,
        'data',
      )
      app.stdin.write(command + '\n')
      const [bytes] = await output
      const pid = Number(String(bytes).trim())
      children.push(pid)

      return pid
    }

    const tracker = codexProcesses({ pid: app.pid })
    const earlier = await launch({ command: LONG_COMMAND })
    await tracker.begin()
    tracker.command({
      id: 'background',
      command: 'sleep 121',
      completed: false,
    })
    const background = await launch({ command: 'sleep 121' })
    tracker.command({
      id: 'background',
      command: 'sleep 121',
      completed: true,
    })
    tracker.command({
      id: 'foreground',
      command: LONG_COMMAND,
      completed: false,
    })
    const foreground = await launch({ command: LONG_COMMAND })
    const cleanup = await tracker.capture()
    const stopped = await cleanup()
    assert.ok(stopped.includes(foreground))
    assert.doesNotThrow(() => process.kill(
      app.pid!,
      0,
    ))
    assert.doesNotThrow(() => process.kill(
      earlier,
      0,
    ))
    assert.doesNotThrow(() => process.kill(
      background,
      0,
    ))
    await until({
      what: 'foreground process reaped',
      check: () => {
        try {
          process.kill(
            foreground,
            0,
          )

          return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return true
          }

          throw error
        }
      },
    })
    assert.throws(
      () => process.kill(
        foreground,
        0,
      ),
      { code: 'ESRCH' },
    )
  },
)

test(
  'Codex Stop consumes native command arrays and kills only unfinished foreground processes',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-processes-',
    ))
    const session = await codexProvider({
      spawnCodex: ({
        cwd,
        env,
      })=>spawn(
        process.execPath,
        [
          join(
            import.meta.dirname,
            'fixtures/codex-stop.mjs',
          ),
        ],
        {
          cwd,
          env,
          stdio:'pipe',
        },
      ),
    }).open({
      cwd:root,
      settings:{},
      env:{},
      signal:new AbortController().signal,
    })
    const input=inbox()

    const messages=async function*(){
      for await(const message of input){
        yield{
          id:message.id!,
          text:message.text,
          images:[],
        }
      }
    }

    const consume=async()=>{
      for await(const event of session.run({
        input:messages(),
        permission:async()=>({
          behavior:'deny',
          message:'unused',
        }),
      })){
        if(typeof event==='object' && event.type==='turn-ended') {
          assert.equal(
            event.outcome.status,
            'interrupted',
          )
        }
      }
    }

    const done=consume()
    t.after(async()=>{
      input.end();session.close();await done;rmSync(
        root,
        {
          recursive:true,
          force:true,
        },
      )
    })
    input.push({
      id:'command-array',
      text:'Run the synthetic foreground command',
    })
    await until({
      what:'native foreground starts',
      check:()=>existsSync(join(
        root,
        'pids.json',
      )) && existsSync(join(
        root,
        'started',
      )) && session.snapshot().work.runningTurns.length === 1,
    })
    const pids=JSON.parse(readFileSync(
      join(
        root,
        'pids.json',
      ),
      'utf8',
    )) as {
      earlier:number
      background:number
      foreground:number
      action:number
    }
    await session.interrupt()
    await until({
      what:'interrupted outcome',
      check:()=>session.snapshot().outcome?.status === 'interrupted',
    })
    assert.equal(
      session.snapshot().outcome?.stoppedProcesses?.includes(pids.foreground),
      true,
    )
    await until({
      what:'foreground process exits',
      check:()=>{
        try{
          process.kill(
            pids.foreground,
            0,
          )

          return false
        }catch(error){
          if((error as NodeJS.ErrnoException).code==='ESRCH'){
            return true
          }

          throw error
        }
      },
    })
    assert.equal(
      session.snapshot().outcome?.stoppedProcesses?.includes(pids.action),
      true,
    )
    await until({
      what:'action process exits',
      check:()=>{
        try{
          process.kill(
            pids.action,
            0,
          )

          return false
        }catch(error){
          if((error as NodeJS.ErrnoException).code==='ESRCH'){
            return true
          }

          throw error
        }
      },
    })
    assert.equal(
      existsSync(join(
        root,
        'completed-action',
      )),
      false,
    )
    assert.doesNotThrow(()=>process.kill(
      pids.earlier,
      0,
    ))
    assert.doesNotThrow(()=>process.kill(
      pids.background,
      0,
    ))
    assert.equal(
      existsSync(join(
        root,
        'completed',
      )),
      false,
    )
  },
)
