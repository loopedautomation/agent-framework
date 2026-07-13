#!/usr/bin/env bash
# The action's run step: pipe the prompt into `af run` (the agent runs in
# Docker, as always), keep the transcript, and turn it into step outputs.
# Lives outside action.yml so it can be exercised locally against a real
# transcript. Inputs arrive as AF_ACTION_* env vars; see action.yml.
set -euo pipefail

agent="${AF_ACTION_AGENT:-agent.yaml}"
tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log="$tmp/af-transcript.log"

# A trigger makes the agent a long-lived service, and a CI step has to end.
if grep -qE '^triggers[[:space:]]*:' "$agent"; then
  echo "::error::$agent has triggers - the action is for one-shot agents; deploy service agents with af up" >&2
  exit 1
fi

args=("$agent")

# The container's environment comes from an env file alone, so the secrets
# input becomes one. An explicit env-file input is the base; secrets lines
# are appended and win.
envfile="${AF_ACTION_ENV_FILE:-}"
if [ -n "${AF_ACTION_SECRETS:-}" ]; then
  merged="$tmp/af-action.env"
  : >"$merged"
  chmod 600 "$merged"
  if [ -n "$envfile" ]; then
    cat "$envfile" >>"$merged"
    echo >>"$merged"
  fi
  printf '%s\n' "$AF_ACTION_SECRETS" >>"$merged"
  envfile="$merged"
fi
if [ -n "$envfile" ]; then args+=(--env-file "$envfile"); fi
if [ -n "${AF_ACTION_IMAGE:-}" ]; then args+=(--image "$AF_ACTION_IMAGE"); fi

# The repl handles one line per turn, so a multiline prompt would be several
# runs. One-shot means one reply: newlines collapse to spaces.
prompt="$(printf '%s' "${AF_ACTION_PROMPT:?the prompt input is required}" | tr '\n' ' ')"

printf '%s\n' "$prompt" | af run "${args[@]}" | tee "$log"

# The transcript ends with the reply and a status line:
#   <name> (<handle>) is listening (model: ...)
#   <name>> <the reply, possibly multiline>
#   [ok · 2 steps · 20in/10out tokens]
# The agent names itself, so learn the name from the header first.
name="$(sed -nE 's/^(.+) \(.+\) is listening \(model: .+/\1/p' "$log" | head -1)"
if [ -z "$name" ]; then
  echo "::error::no repl header in the transcript - the run never reached the agent (transcript above)" >&2
  exit 1
fi

status="$(sed -nE 's/^\[([a-z_]+) · .+\]$/\1/p' "$log" | tail -1)"
reply="$(awk -v n="$name" '
  BEGIN { marker = n "> " }
  !grab && index($0, marker) == 1 { grab = 1; $0 = substr($0, length(marker) + 1) }
  grab && /^\[[a-z_]+ · .+\]$/ { exit }
  grab { print }
' "$log")"

delim="AF_REPLY_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
{
  echo "reply<<$delim"
  printf '%s\n' "$reply"
  echo "$delim"
  echo "status=${status:-unknown}"
} >>"${GITHUB_OUTPUT:-/dev/null}"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### $name replied"
    echo
    printf '%s\n' "$reply"
    echo
    echo "\`status: ${status:-unknown}\`"
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "${status:-}" != "ok" ]; then
  echo "::error::the run ended with status ${status:-unknown} (transcript above)" >&2
  exit 1
fi
