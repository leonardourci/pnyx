#!/bin/sh
# Pnyx reporting hook, installed by `pnyx-axi setup hooks` as
#   <PNYX_HOME>/hooks/pnyx-hook.sh <claude|codex> <HookEventName>
# Reads the harness payload on stdin and hands one JSON line to the default board's
# server socket or, when that fails, to its spool. It prints nothing, never waits
# on a network call, browser or model, and always exits 0: Claude Code
# and Codex add some hook output to the agent's context, and a hook must never
# block the agent. Normalizing the payload into a card happens later, in pnyx-axi.
exec >/dev/null 2>&1
# Bytes, not characters: tr and grep must not stop at invalid UTF-8 in a payload.
export LC_ALL=C

harness=$1
event=$2
case $harness in claude | codex) ;; *) exit 0 ;; esac
case $event in '' | *[!A-Za-z]*) exit 0 ;; esac

# The script lives in <PNYX_HOME>/hooks/.
home=${0%/*}
home=${home%/hooks}

# One date call gives both the epoch ($1) and the ISO time ($2).
# shellcheck disable=SC2046
set -- $(date -u '+%s %Y-%m-%dT%H:%M:%SZ')
id="hook-$1-$$"
board=$home/boards/default
spool=$board/spool
[ -d "$spool" ] || mkdir -p "$spool" || exit 0
# ponytail: names order by whole seconds, then by the zero-padded process id, which
# keeps one session's same-second hooks in order (each runs after the last) until the
# process ids wrap; a sub-second clock needs more than POSIX date.
name=$(printf '%012d000-%010d' "$1" $$)-$id.json
tmp=$spool/.tmp-$name

# The payload streams through tr into the line without the shell holding it, so a
# large tool output costs little. JSON strings cannot hold raw newlines, so
# flattening keeps the payload valid on one line.
{
  printf '{"v":1,"id":"%s","at":"%s","harness":"%s","event":"%s","payload":' "$id" "$2" "$harness" "$event"
  tr '\n\r' '  '
  printf '}\n'
} >"$tmp" || exit 0

# Empty input has nothing after the envelope's own "payload": key.
if ! grep -q '"payload": *[^ }]' "$tmp"; then
  printf '{"v":1,"id":"%s","at":"%s","harness":"%s","event":"%s","payload":null}\n' "$id" "$2" "$harness" "$event" >"$tmp" || exit 0
fi

# The default board's server handles each line as soon as its newline arrives and
# replies nothing, so nothing here relies on nc half-closing; -w 1 bounds the wait
# for an nc that keeps the connection open. Without a running server there is no
# socket file, so the common path never starts nc.
if [ -S "$board/server.sock" ] && nc -U -w 1 "$board/server.sock" <"$tmp"; then
  rm -f "$tmp"
  exit 0
fi

mv "$tmp" "$spool/$name" || rm -f "$tmp"
exit 0
