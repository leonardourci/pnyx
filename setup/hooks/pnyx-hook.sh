#!/bin/sh
# Pnyx reporting hook, installed by `pnyx-axi setup hooks` as
#   <PNYX_HOME>/hooks/pnyx-hook.sh <claude|codex> <HookEventName>
# Reads the harness payload on stdin and hands one JSON line to its board's server
# socket (the default board unless PNYX_BOARD names another) or, when that fails,
# to its spool. It prints nothing, never waits on a network call, browser or model,
# and always exits 0: Claude Code and Codex add some hook output to the agent's
# context, and a hook must never block the agent. Normalizing the payload into a card happens later, in pnyx-axi.
exec >/dev/null 2>&1
# Bytes, not characters: tr and grep must not stop at invalid UTF-8 in a payload.
export LC_ALL=C
set -f

harness=$1
event=$2
case $harness in claude | codex) ;; *) exit 0 ;; esac
case $event in '' | *[!A-Za-z]*) exit 0 ;; esac

# The script lives in <PNYX_HOME>/hooks/. A session started for another home or
# board, such as a task's agent started in Paseo, carries PNYX_HOME and PNYX_BOARD
# and reports there instead.
home=${0%/*}
home=${home%/hooks}
case ${PNYX_HOME:-} in /*) home=$PNYX_HOME ;; esac
board_name=${PNYX_BOARD:-default}
case $board_name in [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) exit 0 ;; esac

# Where the session's terminal is, so a reply can be typed into it: the harness
# process and its TTY, and the host around it from the environment. Recorded when
# a session starts or takes a prompt; a value outside the safe characters is left out.
terminal=
fact() {
  case $2 in '' | -* | *[!A-Za-z0-9_./:%,@+=-]*) return ;; esac
  terminal="$terminal${terminal:+,}\"$1\":\"$2\""
}
case $event in
SessionStart | UserPromptSubmit)
  # Stop at the first non-shell ancestor. A headless harness must not borrow a
  # terminal from an unrelated ancestor further up the process tree.
  pid=$PPID
  for _ in 1 2 3 4; do
    # shellcheck disable=SC2046
    set -- $(ps -o ppid= -o tty= -o comm= -p "$pid")
    [ $# -ge 3 ] || break
    case ${3##*/} in
    sh | bash | zsh | dash | -*) ;;
    *)
      case $2 in '?' | '??' | '-') break ;; esac
      fact tty "/dev/$2"
      fact pid "$pid"
      break
      ;;
    esac
    [ "$1" -gt 1 ] || break
    pid=$1
  done
  fact program "${TERM_PROGRAM:-}"
  [ -z "${TMUX:-}" ] || fact tmux "${TMUX%%,*}"
  fact tmuxPane "${TMUX_PANE:-}"
  fact paseoTerminal "${PASEO_TERMINAL_ID:-}"
  fact paseoHome "${PASEO_HOME:-}"
  fact herdrSession "${HERDR_SESSION:-}"
  fact herdrPane "${HERDR_PANE_ID:-}"
  ;;
esac
[ -z "$terminal" ] || terminal="\"terminal\":{$terminal},"

# One date call gives both the epoch ($1) and the ISO time ($2).
# shellcheck disable=SC2046
set -- $(date -u '+%s %Y-%m-%dT%H:%M:%SZ')
id="hook-$1-$$"
board=$home/boards/$board_name
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
  printf '{"v":1,"id":"%s","at":"%s","harness":"%s","event":"%s",%s"payload":' "$id" "$2" "$harness" "$event" "$terminal"
  tr '\n\r' '  '
  printf '}\n'
} >"$tmp" || exit 0

# Empty input has nothing after the envelope's own "payload": key.
if ! grep -q '"payload": *[^ }]' "$tmp"; then
  printf '{"v":1,"id":"%s","at":"%s","harness":"%s","event":"%s",%s"payload":null}\n' "$id" "$2" "$harness" "$event" "$terminal" >"$tmp" || exit 0
fi

# The board's server handles each line as soon as its newline arrives and
# replies nothing, so nothing here relies on nc half-closing; -w 1 bounds the wait
# for an nc that keeps the connection open. Without a running server there is no
# socket file, so the common path never starts nc.
if [ -S "$board/server.sock" ] && nc -U -w 1 "$board/server.sock" <"$tmp"; then
  rm -f "$tmp"
  exit 0
fi

mv "$tmp" "$spool/$name" || rm -f "$tmp"
exit 0
