if (process.argv[2] === 'serve' && process.env.PNYX_TEST_STALL_RESTART === '1') {
  const once = process.once

  process.once = function (
    event,
    listener,
  ) {
    if (event === 'SIGUSR2') {
      return once.call(
        this,
        event,
        // eslint-disable-next-line pnyx/object-params -- process.once owns the signal callback.
        (...args) => {
          process.kill(
            process.pid,
            'SIGSTOP',
          )
          listener(...args)
        },
      )
    }

    return once.call(
      this,
      event,
      listener,
    )
  }
}
