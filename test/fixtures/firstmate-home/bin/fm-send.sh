#!/bin/sh
# Fake Firstmate send command for tests: records its FM_HOME and arguments,
# then exits with the status in $FM_HOME/send-exit (0 when absent).
{
  printf 'FM_HOME=%s\n' "$FM_HOME"
  for arg in "$@"; do printf 'arg=%s\n' "$arg"; done
  printf -- '---\n'
} >> "$FM_HOME/sent.log"
code=0
[ -f "$FM_HOME/send-exit" ] && code=$(cat "$FM_HOME/send-exit")
[ "$code" = 0 ] || echo "error: fake send failed with $code" >&2
exit "$code"
