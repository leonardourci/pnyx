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

# Tool hooks fire for every shell command; only the pull request and deploy commands
# listed in observe.ts (PR_COMMANDS, DEPLOY_COMMANDS) are reported. This passes any
# payload containing one; pnyx-axi then checks the command is in command position.
case $event in
PreToolUse | PostToolUse)
  case $payload in
  *'gh pr create'* | *'gh pr merge'* | *'gh-axi pr create'* | *'gh-axi pr merge'*) ;;
  *'wrangler deploy'* | *'railway up'* | *'vercel deploy'* | *'vercel --prod'* | *'netlify deploy'* | *'fly deploy'*) ;;
  *'eas update'* | *'eas submit'* | *'npm run deploy'* | *'pnpm run deploy'* | *'yarn run deploy'* | *'bun run deploy'*) ;;
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

# The default board's server handles each line as soon as its newline arrives and
# replies nothing, so nothing here relies on nc half-closing; -w 1 bounds the wait
# for an nc that keeps the connection open. Without a running server there is no
# socket file, so the common path never starts nc.
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
