/* eslint-disable pnyx/object-params -- Playwright owns evaluation callback signatures. */
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { MOTION_CSS_EASING, MOTION_DURATIONS, motionDuration } from '../../web/src/shared/motion.ts'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

const SAMPLE_FRAMES = 60
const STABLE_LAYOUT_FRAMES = 3
let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the global off switch and OS reduced motion make CSS and TypeScript motion instant',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'motion',
        '--title',
        'Motion target',
      ],
    })
    const target = await hydra.task({ key: 'motion' })
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Check motion',
      reply: `Motion checked. [@Motion target](pnyx-task:${target.id})`,
    })
    const session = await hydra.chat({ text: 'Check motion' })
    await until({
      what: 'motion reply',
      check: () => session.answered === 1,
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    onTestFinished(async () => {
      await page.context().close()
    })
    const label = page.locator(`[data-hydra-workspace="${hydra.id}"] .message`).first()
    const messageDuration = () => label.evaluate(
      element => getComputedStyle(element).animationDuration,
    )
    expect(parseFloat(await messageDuration())).toBeGreaterThan(0)
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    const knob = page.locator('.settings-page:not([hidden]) .switch-track > span').first()
    await knob.waitFor()
    const timing = () => knob.evaluate(element => ({
      duration: getComputedStyle(element).transitionDuration,
      easing: getComputedStyle(element).transitionTimingFunction,
    }))
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'off'
    })
    expect((await timing()).duration).toBe('0s')
    expect(motionDuration({ mode: 'off' })).toBe(0)
    await page.getByRole(
      'button',
      {
        name: 'Close Settings',
        exact: true,
      },
    ).click()
    expect(await messageDuration()).toBe('0s')
    await page.evaluate(
      taskId => {
        const animate = Element.prototype.animate

        Element.prototype.animate = function (
          this: Element,
          frames,
          options,
        ) {
          const animation = animate.call(
            this,
            frames,
            options,
          )

          const task = this.closest('[data-task]')
          const hasShadow = Array.isArray(frames) && frames.some(frame => 'boxShadow' in frame)

          if (task?.getAttribute('data-task') === taskId && hasShadow) {
            const duration = animation.effect?.getComputedTiming().duration
            document.documentElement.dataset.taskHighlightDuration = String(duration)
            Element.prototype.animate = animate
          }

          return animation
        }
      },
      target.id,
    )
    await page.locator('.hydra-chat .task-reference-title').filter({ hasText: 'Motion target' })
      .click()
    await expect.poll(() => page.locator('html').getAttribute('data-task-highlight-duration')).toBe('0')
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'normal'
    })
    expect(parseFloat(await messageDuration())).toBeGreaterThan(0)
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    await knob.waitFor()
    expect(await timing()).toEqual({
      duration: `${MOTION_DURATIONS.base / 1000}s`,
      easing: MOTION_CSS_EASING,
    })

    for (const [
      speed,
      milliseconds,
    ] of Object.entries(MOTION_DURATIONS)) {
      const value = await page.evaluate(
        name => getComputedStyle(document.documentElement).getPropertyValue(`--transition-duration-${name}`)
          .trim(),
        speed,
      )
      expect(parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)).toBe(milliseconds)
    }

    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect((await timing()).duration).toBe('0s')
    await page.getByRole(
      'button',
      {
        name: 'Close Settings',
        exact: true,
      },
    ).click()
    expect(await messageDuration()).toBe('0s')
    expect(motionDuration({ reducedMotion: true })).toBe(0)
  },
)

test(
  'opening a visible card keeps its scroll anchor and contains every painted frame',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'first',
        '--title',
        'Keep the first task visible',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'second',
        '--title',
        'Keep a longer task title visible before the family opens',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'open',
        '--title',
        'Open without a flash',
        '--brief',
        'Keep the opening surface calm.',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'next',
        '--title',
        'Keep the next task visible',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'child',
        '--title',
        'Keep the compact child',
        '--parent',
        'open',
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { ideas: 280 } } }),
      ],
    })

    for (const theme of [
      'light',
      'dark',
    ]) {
      const page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
      })

      try {
        await page.evaluate(
          async theme => {
            document.documentElement.dataset.theme = theme
            await document.fonts.ready
          },
          theme,
        )
        const title = page.getByRole(
          'button',
          {
            name: 'Open without a flash',
            exact: true,
          },
        )
        await title.hover()
        const frames = title.evaluate(
          async (
            trigger,
            frameCount,
          ) => {
            const card = trigger.closest<HTMLElement>('.card')!
            const scroll = card.closest<HTMLElement>('.column-cards')!
            const start = scroll.scrollTop
            await new Promise<void>(resolve => trigger.addEventListener(
              'click',
              () => resolve(),
              { once: true },
            ))
            let scrollDelta = 0, escaped = false, replaced = false

            for (let frame = 0; frame < frameCount; frame++) {
              await new Promise(requestAnimationFrame)
              replaced ||= !card.isConnected
              scrollDelta = Math.max(
                scrollDelta,
                Math.abs(scroll.scrollTop - start),
              )
              const bounds = card.getBoundingClientRect()

              for (const fraction of [
                0.25,
                0.75,
              ]) {
                for (const y of [
                  bounds.bottom + 12,
                  card.querySelector('.card-content')!.getBoundingClientRect().bottom - 4,
                ]) {
                  if (y <= bounds.bottom) {
                    continue
                  }

                  const hit = document.elementFromPoint(
                    bounds.left + bounds.width * fraction,
                    y,
                  )
                  escaped ||= !!hit && card.contains(hit) && !hit.closest('[popover], .resize')
                }
              }
            }

            return {
              scrollDelta,
              escaped,
              replaced,
            }
          },
          SAMPLE_FRAMES,
        )
        await title.click()
        const result = await frames
        expect(result.scrollDelta).toBeLessThan(0.5)
        expect({
          escaped: result.escaped,
          replaced: result.replaced,
        }).toEqual({
          escaped: false,
          replaced: false,
        })
      } finally {
        await page.context().close()
      }
    }
  },
)

test(
  'resizing the task modal keeps its close action anchored and its icons undistorted',
  async () => {
    const hydra = await pnyx.hydra()
    const title = 'Keep a long task title readable while resizing its conversation and instructions'
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'resize-modal',
        '--title',
        title,
      ],
    })

    for (const theme of [
      'light',
      'dark',
    ]) {
      const page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
      })

      try {
        await page.evaluate(
          async theme => {
            document.documentElement.dataset.theme = theme
            await document.fonts.ready
          },
          theme,
        )
        await page.getByRole(
          'button',
          {
            name: title,
            exact: true,
          },
        ).hover()
        await page.getByRole(
          'button',
          {
            name: 'Open modal',
            exact: true,
          },
        ).click()
        const modal = page.getByRole(
          'dialog',
          {
            name: title,
            exact: true,
          },
        )
        await until({
          what: 'the modal finishes opening before resizing',
          check: async () => {
            const bounds = await modal.boundingBox()
            const settled = await modal.evaluate(element => getComputedStyle(element).transform === 'none')

            return settled && !!bounds
              && Math.abs(bounds.width - 1008) < 1
              && Math.abs(bounds.height - 720) < 1
          },
        })

        for (const [
          axis,
          delta,
        ] of [
            [
              'width',
              -500,
            ],
            [
              'height',
              -500,
            ],
            [
              'width',
              300,
            ],
            [
              'height',
              200,
            ],
          ] as const) {
          const grip = modal.getByRole(
            'separator',
            {
              name: `Resize task modal ${axis}`,
              exact: true,
            },
          )
          await grip.hover()
          const bounds = (await grip.boundingBox())!
          const sampling = modal.evaluate(
            async (
              dialog,
              frameCount,
            ) => {
              const close = dialog.querySelector<HTMLElement>(
                '.dialog-head [aria-label="Close"]',
              )!

              const anchor = () => {
                const surface = dialog.getBoundingClientRect()
                const button = close.getBoundingClientRect()

                return {
                  right: surface.right - button.right,
                  top: button.top - surface.top,
                }
              }

              const initial = anchor()
              let anchorDrift = 0, iconDistortion = 0

              for (let frame = 0; frame < frameCount; frame++) {
                await new Promise(requestAnimationFrame)
                const current = anchor()
                anchorDrift = Math.max(
                  anchorDrift,
                  Math.abs(current.right - initial.right),
                  Math.abs(current.top - initial.top),
                )

                for (const icon of dialog.querySelectorAll<SVGElement>('.dialog-head svg, [data-card-header] svg')) {
                  const bounds = icon.getBoundingClientRect(), style = getComputedStyle(icon)
                  iconDistortion = Math.max(
                    iconDistortion,
                    Math.abs(bounds.width - parseFloat(style.width)),
                    Math.abs(bounds.height - parseFloat(style.height)),
                  )
                }
              }

              return {
                anchorDrift,
                iconDistortion,
              }
            },
            SAMPLE_FRAMES,
          )
          await page.mouse.move(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          )
          await page.mouse.down()
          await page.mouse.move(
            bounds.x + bounds.width / 2 + (axis === 'width' ? delta : 0),
            bounds.y + bounds.height / 2 + (axis === 'height' ? delta : 0),
            { steps: 20 },
          )
          await page.mouse.up()
          const result = await sampling
          expect.soft(result.anchorDrift).toBeLessThan(0.5)
          expect.soft(result.iconDistortion).toBeLessThan(0.5)
        }
      } finally {
        await page.context().close()
      }
    }
  },
)

test(
  'closing the task modal folds it back into the card slot it opened from',
  async () => {
    const hydra = await pnyx.hydra()

    for (let index = 0; index < 16; index++) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--key',
          `fold-${index}`,
          '--title',
          `Fold back task ${index}`,
        ],
      })
    }

    for (const theme of [
      'light',
      'dark',
    ]) {
      const page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
      })

      try {
        await page.evaluate(
          async theme => {
            document.documentElement.dataset.theme = theme
            await document.fonts.ready
          },
          theme,
        )
        const column = page.locator(`[data-hydra-workspace="${hydra.id}"] section[data-column="ideas"]`)
        const scroller = column.locator('.project-cards')
        const scrollTop = () => scroller.evaluate(element => element.scrollTop)
        await column.locator('.card[data-task]').first()
          .waitFor()
        await scroller.evaluate(element => {
          element.scrollTop = element.scrollHeight
        })
        await until({
          what: 'the scrolled column settles',
          check: () => scroller.evaluate(element => element.scrollTop > 0
            && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 1),
        })
        const id = await column.evaluate(section => {
          const visible = section.querySelector('.project-cards')!.getBoundingClientRect()

          return [...section.querySelectorAll<HTMLElement>('.card[data-task]')]
            .filter(card => {
              const box = card.getBoundingClientRect()

              return box.top >= visible.top && box.bottom <= visible.bottom
            })
            .at(-1)!.dataset.task!
        })
        const card = column.locator(`.card[data-task="${id}"]:not(dialog *)`)
        const title = card.locator('.card-open')

        const box = async () => {
          const bounds = (await card.boundingBox())!

          return [
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
          ]
        }

        const foldBack = async ({ expanded }: { expanded: boolean }) => {
          await card.hover()
          const openModalButton = card.getByRole(
            'button',
            {
              name: 'Open modal',
              exact: true,
            },
          )
          await openModalButton.hover()
          await until({
            what: 'the card and its column stop moving before opening the modal',
            check: () => card.evaluate(
              async (element, frames) => {
                const scroll = element.closest('.project-cards')
                const position = () => {
                  const { x, y, width, height } = element.getBoundingClientRect()

                  return JSON.stringify([x, y, width, height, scroll?.scrollTop])
                }
                const initial = position()

                for (let frame = 0; frame < frames; frame++) {
                  await new Promise(requestAnimationFrame)

                  if (position() !== initial) {
                    return false
                  }
                }

                return true
              },
              STABLE_LAYOUT_FRAMES,
            ),
          })
          const slot = await box()
          const scrolled = await scrollTop()
          await openModalButton.click()
          const modal = page.locator('dialog.task-modal')
          await until({
            what: 'the modal finishes opening',
            check: async () => await modal.evaluate(element => getComputedStyle(element).transform === 'none'),
          })
          const placeholder = (await column.locator('.card[aria-hidden]').boundingBox())!
          expect([
            placeholder.x,
            placeholder.y,
            placeholder.width,
            placeholder.height,
          ]).toEqual(slot.map(value => expect.closeTo(
            value,
            0,
          )))
          expect(await scrollTop()).toBe(scrolled)
          const close = modal.getByRole(
            'button',
            {
              name: 'Close',
              exact: true,
            },
          ).first()
          const sampling = await close.evaluateHandle(
            (
              button,
              {
                task,
                frameCount,
              },
            ) => {
              const clicked = new Promise<void>(resolve => button.addEventListener(
                'click',
                () => resolve(),
                {
                  capture: true,
                  once: true,
                },
              ))
              const sample = async () => {
                await clicked
                const boxes: number[][] = []

                for (let frame = 0; frame < frameCount; frame++) {
                  await new Promise(requestAnimationFrame)
                  const node = document.querySelector(`.card[data-task="${CSS.escape(task)}"]:not(dialog *)`)

                  if (node) {
                    const bounds = node.getBoundingClientRect()
                    boxes.push([
                      bounds.x,
                      bounds.y,
                      bounds.width,
                      bounds.height,
                    ])
                  }
                }

                return boxes
              }

              return { path: sample() }
            },
            {
              task: id,
              frameCount: SAMPLE_FRAMES,
            },
          )
          await close.click()
          await modal.waitFor({ state: 'detached' })
          const path = await sampling.evaluate(({ path }) => path)
          await sampling.dispose()
          const distance = (bounds: number[]) => Math.max(...bounds.map((
            value,
            index,
          ) => Math.abs(value - slot[index]!)))
          const distances = path.map(distance)
          expect(
            Math.max(...distances),
            JSON.stringify(path),
          ).toBeGreaterThan(1)
          expect(
            distances.at(-1),
            JSON.stringify(path),
          ).toBeLessThan(1)
          expect(
            distances.every((
              value,
              index,
            ) => index === 0 || value <= distances[index - 1]! + 1),
            JSON.stringify(path),
          ).toBe(true)
          expect(await scrollTop()).toBe(scrolled)
          expect(await title.getAttribute('aria-expanded')).toBe(String(expanded))
        }

        await foldBack({ expanded: false })
        await title.click()
        await until({
          what: 'the card opens inline',
          check: async () => await title.getAttribute('aria-expanded') === 'true'
            && await card.evaluate(element => getComputedStyle(element).transform === 'none'),
        })
        await foldBack({ expanded: true })
        await title.click()
      } finally {
        await page.context().close()
      }
    }
  },
)
