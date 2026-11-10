/* global document, NodeFilter, CSS, requestAnimationFrame, cancelAnimationFrame */
/* eslint @typescript-eslint/no-unused-expressions: "off" -- The harness injects this function into the browser. */
({
  marker,
  expected,
}) => {
  const normalize = ({ value }) => value.replace(
    /\s/g,
    '',
  )
  const decorations = '.comment-card, .comment-pill, .comment-annotations, .code-language, .receipt'
  const failures = []
  let previous = '', element, frames = 0, changes = 0, running = true, frame
  const oracle = expected === undefined ? undefined : normalize({ value: expected })

  const text = ({
    host,
    revealed,
  }) => {
    const walker = document.createTreeWalker(
      host,
      NodeFilter.SHOW_TEXT,
    )
    const hidden = [...(CSS.highlights?.get('reveal-hide') ?? [])]
    let node, result = ''

    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest(decorations)) {
        continue
      }

      let end = node.data.length

      if (revealed) {
        for (const range of hidden) {
          if (range.startContainer === node) {
            end = Math.min(
              end,
              range.startOffset,
            )
          } else if (range.comparePoint(
            node,
            0,
          ) === 0) {
            end = 0
          }
        }
      }

      result += node.data.slice(
        0,
        end,
      )
    }

    return normalize({ value: result })
  }

  const sample = () => {
    frames++
    const rows = [...document.querySelectorAll('.hydra-chat article.message:not(.mine):not([data-pnyx])')]
      .filter(row => {
        const markdown = row.querySelector('.markdown')

        return markdown && text({
          host: markdown,
          revealed: false,
        })
          .startsWith(normalize({ value: marker }))
      })

    if (rows.length > 1) {
      failures.push('duplicate logical reply')
    }

    const row = rows[0]

    if (row) {
      if (element && row !== element) {
        failures.push('reply remounted')
      }

      element = row
      const visible = text({
        host: row.querySelector('.markdown'),
        revealed: true,
      })

      if (!visible.startsWith(previous)) {
        failures.push('revealed content shrank or changed')
      }

      if (oracle !== undefined && !oracle.startsWith(visible)) {
        failures.push('revealed content differs from native text')
      }

      if (visible !== previous) {
        changes++
      }

      previous = visible
    } else if (element) {
      failures.push('reply disappeared')
    }

    if (failures.length > 20) {
      running = false
    }

    if (running) {
      frame = requestAnimationFrame(sample)
    }
  }

  frame = requestAnimationFrame(sample)

  return {
    async waitFor({
      wanted,
      finish,
    }) {
      const target = normalize({ value: wanted })
      const until = performance.now() + 30000

      await new Promise((
        resolve,
        reject,
      ) => {
        const check = () => {
          if (failures.length) {
            running = false
            reject(new Error(JSON.stringify(failures)))
          } else if (previous === target && changes > 0) {
            resolve()
          } else if (performance.now() >= until) {
            running = false
            reject(new Error(`Revealed ${previous.length} of ${target.length} characters`))
          } else {
            requestAnimationFrame(check)
          }
        }

        check()
      })

      if (finish) {
        running = false
        cancelAnimationFrame(frame)
      }

      return {
        frames,
        changes,
        characters: previous.length,
        failures,
      }
    },
  }
}
