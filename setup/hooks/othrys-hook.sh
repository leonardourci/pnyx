#!/bin/sh
# Hooks always exit 0 so reporting never blocks the agent. Only SessionStart prints: the
# Titan's summary for this folder, on the saved stdout (fd 3). Everything else stays silent.
exec 3>&1 >/dev/null 2>&1
# Bytes, not characters: tr and grep must not stop at invalid UTF-8 in a payload.
export LC_ALL=C
set -f

harness=$1
event=$2
context=${3:-}
case $harness in claude | codex) ;; *) exit 0 ;; esac
case $event in '' | *[!A-Za-z]*) exit 0 ;; esac

home=${0%/*}
home=${home%/hooks}
case ${OTHRYS_HOME:-} in /*) home=$OTHRYS_HOME ;; esac
hydra_name=${OTHRYS_TITAN:-default}
case $hydra_name in [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) exit 0 ;; esac
task=
worker_task=${OTHRYS_TASK:-}
case $worker_task in '' | *[!A-Za-z0-9._:\$-]*) ;; *) task="\"task\":\"$worker_task\"," ;; esac

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
  fact herdrSession "${HERDR_SESSION:-}"
  fact herdrPane "${HERDR_PANE_ID:-}"
  ;;
esac
[ -z "$terminal" ] || terminal="\"terminal\":{$terminal},"

hook_clock=$(node -e 'const now = new Date(); const iso = now.toISOString(); console.log(Math.floor(now.getTime() / 1000), iso, iso.slice(-4, -1))') || hook_clock=$(date -u '+%s %Y-%m-%dT%H:%M:%SZ 000')
read -r hook_seconds hook_at hook_milliseconds <<EOF
$hook_clock
EOF
id="hook-$hook_seconds$hook_milliseconds-$$"
hydra_dir=$home/titans/$hydra_name
# An unknown Titan id is dropped instead of starting a new Titan; only the default one is made on first use.
[ -d "$hydra_dir" ] || [ "$hydra_name" = default ] || exit 0
spool=$hydra_dir/spool
[ -d "$spool" ] || mkdir -p "$spool" || exit 0
# The writer orders the completed files by write time, even when process ids wrap.
name=$(printf '%012d%s-%010d' "$hook_seconds" "$hook_milliseconds" $$)-$id.json
tmp=$spool/.tmp-$name

# The payload streams through tr into the line without the shell holding it, so a
# large tool output costs little. JSON strings cannot hold raw newlines, so
# flattening keeps the payload valid on one line.
{
  printf '{"v":1,"id":"%s","at":"%s","harness":"%s","event":"%s",%s%s"payload":' "$id" "$hook_at" "$harness" "$event" "$terminal" "$task"
  tr '\n\r' '  '
  printf '}\n'
} >"$tmp" || exit 0

if ! grep -q '"payload": *[^ }]' "$tmp"; then
  printf '{"v":1,"id":"%s","at":"%s","harness":"%s","event":"%s",%s%s"payload":null}\n' "$id" "$hook_at" "$harness" "$event" "$terminal" "$task" >"$tmp" || exit 0
fi

# The Titan's server handles each line as soon as its newline arrives and
# replies nothing, so nothing here relies on nc half-closing; -w 1 bounds the wait
# for an nc that keeps the connection open. Without a running server there is no
# socket file, so the common path never starts nc.
if [ -S "$hydra_dir/server.sock" ] && nc -U -w 1 "$hydra_dir/server.sock" <"$tmp"; then
  rm -f "$tmp"
else
  mv "$tmp" "$spool/$name" || rm -f "$tmp"
fi

# A worker gets its context from Othrys itself; other sessions get the summary when the
# folder belongs to an attached project. The harness's hook timeout bounds the call.
if [ "$event" = SessionStart ] && [ -z "$task" ] && [ -f "$context" ]; then
  set --
  case $context in *.ts) set -- --conditions=source ;; esac
  summary=$(OTHRYS_HOME=$home node "$@" "$context" "$hydra_name" 2>/dev/null) || summary=
  [ -z "$summary" ] || printf '%s\n' "$summary" >&3
fi
exit 0
