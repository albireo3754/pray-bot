#!/usr/bin/env bash
# lifecycle-logger.sh
# Claude Code hook script — appends lifecycle events to JSONL stream file.
#
# Context is received via stdin as JSON (Claude Code hook standard):
#   session_id, cwd, tool_input.skill, tool_input.args, ...
#
# Required env vars (set by hook command prefix):
#   EVENT_TYPE  — "session.lifecycle" | "skill.lifecycle"
#   PHASE       — "started" | "ended" | "in_progress" | "completed"
#
# Optional env var override:
#   KW_CHAT_STREAM_PATH — custom stream file path

STREAM_FILE="${KW_CHAT_STREAM_PATH:-$HOME/.kw-chat/streams/lifecycle.jsonl}"
mkdir -p "$(dirname "$STREAM_FILE")"

# Read stdin (hook payload JSON) once; pass to python via herestring
STDIN_DATA=$(cat)

LINE=$(EVENT_TYPE="$EVENT_TYPE" PHASE="$PHASE" PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}" \
  python3 -c "
import sys, json, uuid, os
from datetime import datetime, timezone

raw = sys.stdin.read()
try:
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}

event_id = str(uuid.uuid4())
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
session_id = data.get('session_id', 'unknown')
project_path = os.environ.get('PROJECT_DIR') or None
cwd = data.get('cwd') or None
event_type = os.environ.get('EVENT_TYPE', '')
phase = os.environ.get('PHASE', '')

if event_type == 'session.lifecycle':
    event = {
        'id': event_id,
        'eventType': 'session.lifecycle',
        'phase': phase,
        'occurredAtIso': now,
        'sessionId': session_id,
        'provider': 'claude',
        'projectPath': project_path,
        'cwd': cwd,
    }
else:
    tool_input = data.get('tool_input', {})
    skill_name = tool_input.get('skill') or None
    args = tool_input.get('args') or None
    trigger_command = ('/' + skill_name + (' ' + args if args else '')) if skill_name else None
    event = {
        'id': event_id,
        'eventType': 'skill.lifecycle',
        'phase': phase,
        'occurredAtIso': now,
        'sessionId': session_id,
        'provider': 'claude',
        'projectPath': project_path,
        'skillName': skill_name,
        'triggerCommand': trigger_command,
        'turnSeq': None,
        'targetDocPath': None,
    }

print(json.dumps(event, ensure_ascii=False))
" <<< "$STDIN_DATA")

if [ -n "$LINE" ]; then
  echo "$LINE" >> "$STREAM_FILE"
fi
