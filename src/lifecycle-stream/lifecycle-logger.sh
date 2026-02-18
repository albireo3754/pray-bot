#!/usr/bin/env bash
# lifecycle-logger.sh
# Claude Code hook script — appends lifecycle events to JSONL stream file.
#
# Context is received via stdin as JSON (Claude Code hook standard):
#   session_id, cwd, transcript_path, prompt, notification_type, tool_input, ...
#
# Required env var (set by hook command prefix):
#   EVENT_TYPE  — "session.lifecycle" | "skill.lifecycle" | "turn.end" | "turn.start" | "session.activity"
#
# For session.lifecycle only:
#   PHASE       — "started" | "ended"
#
# Optional env var override:
#   KW_CHAT_STREAM_PATH — custom stream file path

STREAM_FILE="${KW_CHAT_STREAM_PATH:-$HOME/.kw-chat/streams/lifecycle.jsonl}"
mkdir -p "$(dirname "$STREAM_FILE")"

# Read stdin (hook payload JSON) once
STDIN_DATA=$(cat)

LINE=$(EVENT_TYPE="$EVENT_TYPE" PHASE="$PHASE" \
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
project_path = data.get('cwd') or None
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

elif event_type == 'skill.lifecycle':
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

elif event_type == 'turn.end':
    # Stop hook: transcript_path은 consumer가 JSONL 읽는 데 사용
    transcript_path = data.get('transcript_path') or None
    event = {
        'id': event_id,
        'eventType': 'turn.end',
        'occurredAtIso': now,
        'sessionId': session_id,
        'provider': 'claude',
        'projectPath': project_path,
        'transcriptPath': transcript_path,
    }

elif event_type == 'turn.start':
    # UserPromptSubmit hook: prompt 직접 캡처
    prompt = data.get('prompt') or None
    event = {
        'id': event_id,
        'eventType': 'turn.start',
        'occurredAtIso': now,
        'sessionId': session_id,
        'provider': 'claude',
        'projectPath': project_path,
        'prompt': prompt,
    }

elif event_type == 'session.activity':
    # Notification hook: notification_type → session.lifecycle phase로 매핑
    notification_type = data.get('notification_type') or ''
    if notification_type == 'permission_prompt':
        phase = 'waiting_permission'
    elif notification_type in ('idle_prompt', 'elicitation_dialog'):
        phase = 'waiting_question'
    else:
        # auth_success 등 무관한 알림은 무시
        sys.exit(0)
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
    sys.exit(0)

print(json.dumps(event, ensure_ascii=False))
" <<< "$STDIN_DATA")

if [ -n "$LINE" ]; then
  echo "$LINE" >> "$STREAM_FILE"
fi
