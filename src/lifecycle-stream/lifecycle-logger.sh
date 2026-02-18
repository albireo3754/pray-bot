#!/usr/bin/env bash
# lifecycle-logger.sh
# Claude Code hook script — appends raw hook payload to JSONL stream.
# Injects hookType (from EVENT_TYPE), phase (from PHASE), and occurredAtIso.
# All transformation logic lives in the consumer (file-stream-consumer.ts).
#
# Required env var (set by hook command prefix):
#   EVENT_TYPE  — "session.lifecycle" | "skill.lifecycle" | "turn.end" | "turn.start" | "session.activity"
# Optional:
#   PHASE       — "started" | "ended" | "in_progress" | "completed"
#   KW_CHAT_STREAM_PATH — custom stream file path

STREAM_FILE="${KW_CHAT_STREAM_PATH:-$HOME/.kw-chat/streams/lifecycle.jsonl}"
mkdir -p "$(dirname "$STREAM_FILE")"

[ -z "$EVENT_TYPE" ] && exit 0

LINE=$(EVENT_TYPE="$EVENT_TYPE" PHASE="${PHASE:-}" python3 -c "
import sys, json, os
from datetime import datetime, timezone
d = json.loads(sys.stdin.read() or '{}')
d['hookType'] = os.environ['EVENT_TYPE']
p = os.environ.get('PHASE', '')
if p: d['phase'] = p
d['occurredAtIso'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
print(json.dumps(d, ensure_ascii=False))
" <<< "$(cat)")

[ -n "$LINE" ] && echo "$LINE" >> "$STREAM_FILE"
