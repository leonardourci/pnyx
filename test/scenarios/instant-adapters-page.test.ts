import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

for (const outcome of [
  'saved',
  'refused',
  'reconnect',
]) {
  test(
    `task creation previews immediately and handles ${outcome} with its stable key`,
    async () => {
      const s = await pnyx.scenario()
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
      await page.shows({
        what: 'connected',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.shows({
        what: 'hold task creation',
        arg: { outcome },
        check: ({ outcome }) => {
          const send = WebSocket.prototype.send
          const control = window as unknown as {
            release(): void
            disconnect(): void
            creates: string[]
            renames: number
            attempt: string
          }
          control.creates = []
          control.renames = 0

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'task' && message.args[0] === 'create') {
              control.creates.push(message.id)
              control.attempt = message.args[message.args.indexOf('--event-id') + 1]

              if (control.creates.length === 1) {
                control.release = () => send.call(
                  this,
                  outcome === 'refused' ? JSON.stringify({
                    ...message,
                    args: [
                      ...message.args,
                      '--parent',
                      'missing-parent',
                    ],
                  }) : data,
                )
                control.disconnect = () => this.close()

                return
              }
            }

            if (message.name === 'task' && message.args[0] === 'rename') {
              control.renames++
            }

            send.call(
              this,
              data,
            )
          }

          return true
        },
      })
      await page.click({ selector: '[aria-label="New task in Queued"]' })
      await page.type({ text: 'Instant task' })
      await page.click({ selector: '[aria-label="Your ask"]' })
      await page.type({ text: 'Keep this request' })

      if (process.env.PNYX_CAPTURE_ADAPTERS && outcome === 'saved') {
        await page.capture({ path: `${process.env.PNYX_CAPTURE_ADAPTERS}/task-before.png` })
      }

      await page.click({
        selector: '.task-create button',
        text: 'Save task',
      })
      const attempt = await page.shows({
        what: 'provisional card selected before the server sees it',
        check: () => {
          const control = window as unknown as { attempt: string }

          return !document.querySelector('.task-create')
        && document.querySelector(`[data-task="task:${control.attempt}"]`)
        && document.querySelector('[data-pending=saving]') && control.attempt
        },
      })
      assert.equal(
        Object.values(s.state().cards).some(card => card.title === 'Instant task'),
        false,
      )

      if (process.env.PNYX_CAPTURE_ADAPTERS && outcome === 'saved') {
        await page.capture({ path: `${process.env.PNYX_CAPTURE_ADAPTERS}/task-pending.png` })
      }

      if (outcome !== 'reconnect') {
        await page.shows({
          what: 'edit the provisional task title',
          check: () => {
            const edit = document.querySelector<HTMLButtonElement>('.card [aria-label="Edit task title"]')
            edit?.click()

            return !!edit
          },
        })
        await page.shows({
          what: 'title editor focused',
          check: () => document.activeElement?.getAttribute('aria-label') === 'Task title',
        })
        await page.type({ text: ' renamed' })
        await page.press({ key: 'Enter' })
        await page.shows({
          what: 'dependent rename remains queued',
          check: () => {
            const control = window as unknown as { renames: number }

            return document.querySelector('.card')?.textContent?.includes('Instant task renamed') && { sent: control.renames }
          },
        }).then(result => assert.equal(
          result.sent,
          0,
        ))
      }

      if (outcome === 'refused') {
        await s.owner({
          args: [
            'column',
            'describe',
            'queued',
            '--description',
            'Independent change',
          ],
        })
      }

      await page.shows({
        what: 'release or reconnect the held attempt',
        arg: { outcome },
        check: ({ outcome }) => {
          const control = window as unknown as {
            release(): void
            disconnect(): void
          }

          if (outcome === 'reconnect') {
            control.disconnect()
          } else {
            control.release()
          }

          return true
        },
      })

      if (outcome === 'refused') {
        await page.shows({
          what: 'the refusal restores the request without a phantom card',
          check: () =>
            !document.querySelector('[data-task^="task:"]') && document.querySelector('.error-banner'),
        })
        assert.equal(
          Object.values(s.state().cards).some(card => card.title === 'Instant task'),
          false,
        )
        await page.shows({
          what: 'refusal retains independent work and never sends its dependent rename',
          check: () =>
            document.querySelector('.column-queued h2')?.getAttribute('title') === 'Independent change'
          && { sent: (window as unknown as { renames: number }).renames },
        }).then(result => assert.equal(
          result.sent,
          0,
        ))
        await page.shows({
          what: 'original draft restored',
          check: () =>
            (document.querySelector('.task-create [aria-label="Task title"]') as HTMLInputElement | null)?.value === 'Instant task',
        })
        await page.click({
          selector: '.task-create button',
          text: 'Save task',
        })
        await page.shows({
          what: 'retry saved',
          check: () => !document.querySelector('[data-pending]') && !document.querySelector('.task-create'),
        })
        assert.equal(
          s.events().filter(event => event.id === attempt).length,
          1,
        )
        await page.click({ selector: '[aria-label="New task in Queued"]' })
        await page.shows({
          what: 'a later task starts with a fresh empty draft',
          check: () => {
            const title = document.querySelector('.task-create [aria-label="Task title"]') as HTMLInputElement | null

            return title && title.value === ''
          },
        })
      } else {
        await page.shows({
          what: 'canonical task replaces the provisional card without losing its key',
          check: () =>
            document.querySelector('[data-connected=true]') && !document.querySelector('[data-pending]')
        && !document.querySelector('[data-task^="task:"]')
        && [...document.querySelectorAll('.card')].some(card => card.textContent?.includes('Instant task')),
        })

        if (process.env.PNYX_CAPTURE_ADAPTERS && outcome === 'saved') {
          await page.capture({ path: `${process.env.PNYX_CAPTURE_ADAPTERS}/task-after.png` })
        }

        assert.equal(
          Object.values(s.state().cards).filter(card => card.key === `task:${attempt}`).length,
          1,
        )
        assert.equal(
          s.events().filter(event => event.id === attempt).length,
          1,
        )
      }

      await page.close()
    },
  )
}

for (const outcome of [
  'saved',
  'refused',
  'shared',
  'lost-receipt',
]) {
  test(
    `project attachment previews and handles ${outcome}`,
    async () => {
      const s = await pnyx.scenario()
      const folder = s.folder({ name: `project-${outcome}` })

      if (outcome === 'shared') {
        const other = await pnyx.scenario()
        await other.owner({
          args: [
            'project',
            'add',
            folder,
          ],
        })
      }

      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
      await page.shows({
        what: 'connected',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.click({
        selector: '.add-project-box button',
        text: 'Add a folder',
      })
      await page.click({ selector: '[aria-label="Folder path"]' })
      await page.type({ text: folder })
      await page.shows({
        what: 'folder validated',
        check: () => {
          const button = [...document.querySelectorAll<HTMLButtonElement>('.project-form button')].find(button => button.textContent === 'Add project')

          return button && !button.disabled
        },
      })
      await page.shows({
        what: 'hold project attachment',
        arg: { outcome },
        check: ({ outcome }) => {
          const send = WebSocket.prototype.send
          const control = window as unknown as { release(): void }

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'project' && message.args[0] === 'add') {
              if (outcome === 'lost-receipt') {
                const receive = this.onmessage!

                this.onmessage = event => {
                  const response = JSON.parse(String(event.data))

                  if (response.type === 'receipt' && response.id === message.id) {
                    this.close()

                    return
                  }

                  receive.call(
                    this,
                    event,
                  )
                }
              }

              control.release = () => {
                WebSocket.prototype.send = send; send.call(
                  this,
                  data,
                )
              }

              return
            }

            send.call(
              this,
              data,
            )
          }

          return true
        },
      })
      await page.click({
        selector: '.project-form button',
        text: 'Add project',
      })
      await page.shows({
        what: 'attachment shown while its form closes',
        check: () =>
          !document.querySelector('.project-form') && document.querySelector('.add-project-box')?.textContent?.includes('Checking attachment'),
      })
      assert.equal(
        s.state().projects?.some(project => project.path === folder) ?? false,
        false,
      )

      if (outcome === 'refused') {
        rmSync(
          folder,
          { recursive: true },
        )
      }

      await page.shows({
        what: 'release attachment',
        check: () => {
          ;(window as unknown as { release(): void }).release()

          return true
        },
      })

      if (outcome === 'shared') {
        await page.shows({
          what: 'explicit sharing confirmation',
          check: () => document.querySelector('.project-sharing'),
        })
        assert.equal(
          s.state().projects?.some(project => project.path === folder) ?? false,
          false,
        )
        await page.click({
          selector: '.project-sharing button',
          text: 'Cancel',
        })
        await page.shows({
          what: 'confirmation cancelled',
          check: () => !document.querySelector('.project-sharing'),
        })
        assert.equal(
          s.state().projects?.some(project => project.path === folder) ?? false,
          false,
        )
      } else if (outcome === 'refused') {
        await page.shows({
          what: 'refusal restores folder draft',
          arg: { folder },
          check: ({ folder }) =>
            (document.querySelector('[aria-label="Folder path"]') as HTMLInputElement | null)?.value === folder
        && document.querySelector('.notice')?.textContent,
        })
        assert.equal(
          s.state().projects?.some(project => project.path === folder) ?? false,
          false,
        )
      } else {
        await page.shows({
          what: 'attachment confirmed in navigation',
          check: () =>
            !document.querySelector('[data-pending]') && document.querySelector('.panel-project')?.textContent?.includes('project-'),
        })
        assert.equal(
          s.state().projects?.filter(project => project.path === folder && !project.detached)
            .length,
          1,
        )
      }

      if (outcome === 'saved') {
        await page.click({ selector: '[aria-label="Oracle"]' })
        await page.type({ text: 'Projects' })
        await page.shows({
          what: 'project management in the Oracle',
          check: () => document.querySelector('.project-row'),
        })
        await page.shows({
          what: 'hold project settings and detach',
          check: () => {
            const send = WebSocket.prototype.send
            const control = window as unknown as { releaseProject(): void }

            // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
            WebSocket.prototype.send = function(data) {
              const message = JSON.parse(String(data))

              if (message.name === 'project' && [
                'set',
                'remove',
              ].includes(message.args[0])) {
                control.releaseProject = () => send.call(
                  this,
                  data,
                )

                return
              }

              send.call(
                this,
                data,
              )
            }

            return true
          },
        })
        await page.click({ selector: '[aria-label="How work lands for project-saved"]' })
        await page.click({
          selector: '[role=option]',
          text: 'Branch only',
        })
        await page.shows({
          what: 'landing preview while save held',
          check: () =>
            document.querySelector('[aria-label="How work lands for project-saved"]')?.textContent === 'Branch only'
          && document.querySelector('.project-row')?.textContent?.includes('Saving project settings'),
        })
        await page.shows({
          what: 'release landing save',
          check: () => {
            ;(window as unknown as { releaseProject(): void }).releaseProject()

            return true
          },
        })
        await page.shows({
          what: 'landing save confirmed',
          check: () => !document.querySelector('[data-pending]'),
        })
        await page.click({ selector: '[aria-label="Oracle"]' })
        await page.press({ key: 'Escape' })
        await page.click({ selector: '[aria-label="Oracle"]' })
        await page.type({ text: 'Projects' })
        await page.click({ selector: '[aria-label="Detach project-saved"]' })
        await page.shows({
          what: 'detach preview while held',
          check: () => document.querySelector('.project-row.detached')?.textContent?.includes('Detaching'),
        })
        assert.equal(
          s.state().projects?.find(project => project.path === folder)?.detached,
          false,
        )
        await page.shows({
          what: 'release detach',
          check: () => {
            ;(window as unknown as { releaseProject(): void }).releaseProject()

            return true
          },
        })
        await page.shows({
          what: 'detach confirmed',
          check: () => !document.querySelector('[data-pending]') && document.querySelector('.project-row.detached'),
        })
        assert.equal(
          s.state().projects?.find(project => project.path === folder)?.detached,
          true,
        )
      }

      await page.close()
    },
  )
}

for (const recovery of [
  'queued-navigation',
  'lost-receipt',
]) {
  test(
    `Oracle settings recover ${recovery} through shared installation state`,
    async () => {
      const s = await pnyx.scenario()
      const destination = await pnyx.scenario()
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
      await page.shows({
        what: 'connected',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.click({ selector: '[aria-label="Oracle"]' })
      await page.type({ text: 'Semantic search' })
      await page.shows({
        what: 'hold installation setting',
        arg: { recovery },
        check: ({ recovery }) => {
          const send = WebSocket.prototype.send
          const control = window as unknown as {
            release(): void
            settingsSent: number
            interrupted: boolean
          }
          control.settingsSent = 0
          control.interrupted = false

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'settings' && message.args[0] === 'set') {
              control.settingsSent++

              if (recovery === 'lost-receipt') {
                const receive = this.onmessage!

                this.onmessage = event => {
                  const response = JSON.parse(String(event.data))

                  if (response.type === 'receipt' && response.id === message.id) {
                    control.interrupted = true
                    this.close()

                    return
                  }

                  receive.call(
                    this,
                    event,
                  )
                }
              } else if (control.settingsSent === 1) {
                control.release = () => send.call(
                  this,
                  data,
                )

                return
              }
            }

            send.call(
              this,
              data,
            )
          }

          return true
        },
      })
      await page.click({ selector: '[aria-label="Semantic search"]' })
      await page.click({
        selector: '[role=option]',
        text: 'off',
      })
      await page.shows({
        what: 'setting preview immediately visible',
        check: () =>
          document.querySelector('[aria-label="Semantic search"]')?.textContent === 'off',
      })

      if (recovery === 'queued-navigation') {
        await page.click({ selector: '[aria-label="Semantic search"]' })
        await page.click({
          selector: '[role=option]',
          text: 'on',
        })
        await page.shows({
          what: 'queued reversal preview',
          check: () =>
            document.querySelector('[aria-label="Semantic search"]')?.textContent === 'on',
        })
        await page.click({ selector: '[aria-label="Oracle"]' })
        await page.press({ key: 'Escape' })
        await page.shows({
          what: 'Oracle dismissed before selecting another Hydra',
          check: () =>
            document.querySelector('[aria-label="Oracle"]')?.getAttribute('aria-expanded') === 'false'
          && !document.querySelector('#hydra-oracle-results'),
        })
        await page.click({
          selector: '.hydra-name',
          text: destination.hydraId,
        })
        await page.shows({
          what: 'destination connected',
          arg: { id: destination.hydraId },
          check: ({ id }) =>
            location.pathname === `/hydra/${id}/` && document.querySelector('[data-connected=true]') && !document.querySelector('.loading-status'),
        })
        await page.shows({
          what: 'release old Hydra save',
          check: () => {
            ;(window as unknown as { release(): void }).release()

            return true
          },
        })
      } else {
        await page.shows({
          what: 'saved receipt interrupted',
          check: () => (window as unknown as { interrupted: boolean }).interrupted,
        })
      }

      await page.shows({
        what: 'installation saves settled after navigation or reconnect',
        arg: { recovery },
        check: ({ recovery }) => {
          const control = window as unknown as { settingsSent: number }

          return document.querySelector('[data-connected=true]') && !document.querySelector('[data-pending]')
        && control.settingsSent === (recovery === 'queued-navigation' ? 2 : 1)
        },
      })
      await page.click({ selector: '[aria-label="Oracle"]' })

      if (recovery === 'queued-navigation') {
        await page.type({ text: 'Semantic search' })
      }

      await page.shows({
        what: 'shared canonical preference',
        arg: { recovery },
        check: ({ recovery }) =>
          document.querySelector('[aria-label="Semantic search"]')?.textContent === (recovery === 'queued-navigation' ? 'on' : 'off'),
      })
      await page.close()
    },
  )
}
