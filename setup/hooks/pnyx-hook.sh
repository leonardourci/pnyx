#!/bin/sh
# Pnyx reporting hook, installed by `pnyx-axi setup hooks` as
#   <PNYX_HOME>/hooks/pnyx-hook.sh <claude|codex> <HookEventName>
# Reads the harness payload on stdin and hands one JSON line to the default board's
# server socket or, when that fails, to its spool. It prints nothing, never waits
# on a network call, browser or model, and always exits 0: Claude Code
# and Codex add some hook output to the agent's context, and a hook must never
# block the agent. Normalizing the payload into a card happens later, in pnyx-axi.
exec >/dev/null 2>&1

harness=$1
event=$2
case $harness in claude | codex) ;; *) exit 0 ;; esac
case $event in '' | *[!A-Za-z]*) exit 0 ;; esac

# The script lives in <PNYX_HOME>/hooks/.
home=${0%/*}
home=${home%/hooks}

# JSON strings cannot hold raw newlines, so flattening keeps the payload valid on one line.
payload=$(tr '\n\r' '  ')

# Tool hooks fire for every shell command; only pull request and deploy commands are
# reported. pnyx-axi checks the parsed command again, so a loose match here is harmless.
case $event in
PreToolUse | PostToolUse)
  case $payload in
  *'gh pr create'* | *'gh pr merge'* | *'gh-axi pr create'* | *'gh-axi pr merge'* | *deploy*) ;;
  *) exit 0 ;;
  esac
  ;;
esac

case $payload in '' | *[!\ ]*) ;; *) payload= ;; esac
# One date call gives both the epoch ($1) and the ISO time ($2).
# shellcheck disable=SC2046
set -- $(date -u '+%s %Y-%m-%dT%H:%M:%SZ')
id="hook-$1-$$"
line="{\"v\":1,\"id\":\"$id\",\"at\":\"$2\",\"harness\":\"$harness\",\"event\":\"$event\",\"payload\":${payload:-null}}"

# The default board's server spools each line it reads and closes the connection
# once nc closes its side. Without a running server there is no socket file, so
# the common path never starts nc.
board=$home/boards/default
if [ -S "$board/server.sock" ] && printf '%s\n' "$line" | nc -U -w 1 "$board/server.sock"; then
  exit 0
fi

# ponytail: names order by whole seconds, so two hooks in the same second may be
# ingested in either order; a sub-second clock needs more than POSIX date.
spool=$board/spool
[ -d "$spool" ] || mkdir -p "$spool" || exit 0
name=$(printf '%012d000' "$1")-$$-$id.json
printf '%s\n' "$line" >"$spool/.tmp-$name" && mv "$spool/.tmp-$name" "$spool/$name"
exit 0
