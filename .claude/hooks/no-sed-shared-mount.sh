#!/usr/bin/env bash
# PreToolUse gate on Bash. Blocks in-place editor invocations (sed -i, awk -i inplace,
# perl -pi, ruby -i, python fileinput -i) targeting shared bind-mount paths on the VPS.
#
# RCA-driven hardening — prevents the inode-trap pattern that has occurred three times:
#   2026-05-03 — sed -i on Caddyfile broke inode binding (4194305 → 4194330)
#   2026-05-02 — /help/* Caddy matcher (correct truncate-write procedure used)
#   2026-04-30 — CF Origin Cert paste artifact
#
# See: e:/code/AssessIQ/docs/RCA_LOG.md § 2026-05-03
# Exits 0 to allow, exits 2 (with stderr) to block.

set -uo pipefail

INPUT=$(cat)

# Extract the bash command we're about to run.
if command -v jq >/dev/null 2>&1; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
else
  CMD=$(printf '%s' "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

# If no command found, pass through.
if [ -z "$CMD" ]; then
  exit 0
fi

# Override: if the command explicitly sets ALLOW_SHARED_MOUNT_SED=1, pass through.
case "$CMD" in
  *"ALLOW_SHARED_MOUNT_SED=1"*) exit 0 ;;
esac

# -----------------------------------------------------------------------
# Step 1: Detect in-place editor invocations.
#
# Patterns:
#   sed -i          — GNU/BSD in-place flag; may have inline suffix: sed -i.bak, sed -i''
#   awk -i inplace  — gawk in-place feature (also matches gawk -i inplace)
#   perl -pi        — canonical in-place idiom; flag cluster may include other flags
#   perl -i         — bare -i flag (less common but valid)
#   ruby -pi / ruby -i — same pattern as perl
#   python -m fileinput — only the -i flag variant triggers in-place write
# -----------------------------------------------------------------------

EDITOR_MATCHED=""

# sed -i: must be word-boundary 'sed' followed by flags containing -i
# Match: sed -i, sed -i.bak, sed -i'', sed -i"", sed -i<any-non-space>
# Do NOT match: sed -in (n is a valid separate flag — though sed -in is unusual, be safe
# by requiring -i to be followed by end-of-flags, dot, or quote-delimiter, not another letter)
if printf '%s' "$CMD" | grep -qE '\bsed[[:space:]]+((-[a-zA-Z]*[[:space:]]+)*)-i([^a-zA-Z]|$)'; then
  EDITOR_MATCHED="sed -i"
fi

# awk -i inplace / gawk -i inplace
if [ -z "$EDITOR_MATCHED" ]; then
  if printf '%s' "$CMD" | grep -qE '\b(awk|gawk)[[:space:]].*-i[[:space:]]+inplace'; then
    EDITOR_MATCHED="awk/gawk -i inplace"
  fi
fi

# perl -pi / perl -i (flag clusters: -pi, -pie, -wpi, etc.; also standalone -p -i combo)
if [ -z "$EDITOR_MATCHED" ]; then
  if printf '%s' "$CMD" | grep -qE '\bperl[[:space:]].*(-[a-zA-Z]*p[a-zA-Z]*i|-[a-zA-Z]*i[a-zA-Z]*p|-pi|-ip)\b'; then
    EDITOR_MATCHED="perl -pi/-i"
  fi
fi

# ruby -pi / ruby -i
if [ -z "$EDITOR_MATCHED" ]; then
  if printf '%s' "$CMD" | grep -qE '\bruby[[:space:]].*(-[a-zA-Z]*p[a-zA-Z]*i|-[a-zA-Z]*i[a-zA-Z]*p|-pi|-ip|-i)\b'; then
    EDITOR_MATCHED="ruby -pi/-i"
  fi
fi

# python -m fileinput ... -i  (rare but valid in-place mode)
if [ -z "$EDITOR_MATCHED" ]; then
  if printf '%s' "$CMD" | grep -qE '\bpython[[:space:]].*-m[[:space:]]+fileinput.*-i\b'; then
    EDITOR_MATCHED="python -m fileinput -i"
  fi
fi

# No in-place editor found — pass through immediately.
if [ -z "$EDITOR_MATCHED" ]; then
  exit 0
fi

# -----------------------------------------------------------------------
# Step 2: Detect whether the command targets a shared bind-mount path.
#
# BLOCKED roots:
#   /opt/ti-platform/          — Caddy + ti-platform stack
#   /etc/                      — system-wide config
#   /srv/  BUT NOT /srv/assessiq/
#   /var/log/  BUT NOT /var/log/assessiq/
#   /var/backups/  BUT NOT /var/backups/assessiq/
#
# Everything else passes (local repo paths, /tmp/, ~, /srv/assessiq/, etc.)
# -----------------------------------------------------------------------

MATCHED_PATH=""

# Helper: check if CMD contains a path matching a root, with an optional exclusion prefix.
# Usage: check_path <blocked_root> [<allowed_sub_root>]
check_path() {
  local blocked="$1"
  local allowed="${2:-__NONE__}"

  # Find all occurrences of the blocked root in the command.
  # We use grep -oE to extract matching segments.
  local hits
  hits=$(printf '%s' "$CMD" | grep -oE "${blocked}[^[:space:]]*" || true)

  if [ -z "$hits" ]; then
    return 1  # no match
  fi

  # If there's an allowed sub-root, filter out any hit that starts with it.
  if [ "$allowed" = "__NONE__" ]; then
    # All hits are blocked — return the first one.
    MATCHED_PATH=$(printf '%s' "$hits" | head -n1)
    return 0
  fi

  # Check each hit: if it does NOT start with the allowed sub-root, it's blocked.
  while IFS= read -r hit; do
    case "$hit" in
      "${allowed}"*) continue ;;  # own namespace — allowed
      *) MATCHED_PATH="$hit"; return 0 ;;  # blocked
    esac
  done <<< "$hits"

  return 1  # all hits were in the allowed sub-namespace
}

# /opt/ti-platform/ — no sub-namespace exclusion; the whole tree is shared infra.
# Important: /opt/ti-platform-foo is NOT a match; we require the trailing slash.
if check_path '/opt/ti-platform/' ; then
  : # MATCHED_PATH set
# /etc/ — no exclusion
elif check_path '/etc/' ; then
  : # MATCHED_PATH set
# /srv/ — exclude /srv/assessiq/
elif check_path '/srv/' '/srv/assessiq/' ; then
  : # MATCHED_PATH set
# /var/log/ — exclude /var/log/assessiq/
elif check_path '/var/log/' '/var/log/assessiq/' ; then
  : # MATCHED_PATH set
# /var/backups/ — exclude /var/backups/assessiq/
elif check_path '/var/backups/' '/var/backups/assessiq/' ; then
  : # MATCHED_PATH set
else
  # No shared-mount path found — safe to allow.
  exit 0
fi

# -----------------------------------------------------------------------
# Both conditions met: in-place editor AND shared bind-mount path.
# BLOCK with a descriptive error and the recovery procedure.
# -----------------------------------------------------------------------

cat >&2 <<EOF
no-sed-shared-mount hook blocked the command:

  Detected in-place editor (${EDITOR_MATCHED}) targeting shared-bind-mount path:
    ${MATCHED_PATH}

This is the inode-trap pattern. Single-file Docker bind mounts capture the
inode at mount time; in-place editors that rename the file produce a NEW
inode, leaving the container reading stale content. Three RCAs in 4 days
on this project alone:

  - 2026-05-03 — sed -i on Caddyfile broke inode binding (4194305 → 4194330)
  - 2026-05-02 — /help/* Caddy matcher (CORRECT truncate-write procedure)
  - 2026-04-30 — CF Origin Cert paste artifact

Recovery procedure (NOT in-place sed):

  TS=\$(date -u +%Y%m%d-%H%M%S)
  cp ${MATCHED_PATH} ${MATCHED_PATH}.bak.\$TS                # backup with timestamp
  sed 's|...|...|' ${MATCHED_PATH} > /tmp/$(basename "${MATCHED_PATH}").new    # write to /tmp first
  cat /tmp/$(basename "${MATCHED_PATH}").new > ${MATCHED_PATH}                 # truncate-write preserves inode
  stat -c %i ${MATCHED_PATH}                               # confirm inode unchanged
  docker exec <container> caddy validate ...               # validate before reload
  docker exec <container> caddy reload ...

See e:/code/AssessIQ/docs/RCA_LOG.md § 2026-05-03 for the full recovery
procedure and the matching CLAUDE.md rule #8 shared-VPS additive-only constraint.

Override (use sparingly, only with explicit user approval — this hook
exists because the inode rule has been broken three times already):

  ALLOW_SHARED_MOUNT_SED=1 <your command>
EOF

exit 2
