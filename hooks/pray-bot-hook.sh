#!/bin/bash
# hooks/pray-bot-hook.sh
# Claude Code hook → pray-bot HTTP push
# 모든 hook event에서 공유. async로 실행되어 Claude Code를 블록하지 않음.
#
# 환경변수:
#   PRAY_BOT_URL      — pray-bot HTTP base URL (default: http://localhost:4488)
#   PRAY_BOT_PROVIDER — provider 식별자 (default: claude)

PRAY_BOT_URL="${PRAY_BOT_URL:-http://localhost:4488}"
PROVIDER="${PRAY_BOT_PROVIDER:-claude}"

# jq 필수
command -v jq >/dev/null 2>&1 || { echo "pray-bot-hook: jq is required but not found" >&2; exit 0; }

# stdin에서 hook event JSON 읽기 + provider 필드 주입
INPUT=$(cat | jq -c --arg p "$PROVIDER" '. + {provider: $p}')

# pray-bot에 전달 (fire-and-forget, 1초 timeout)
curl -s -X POST "${PRAY_BOT_URL}/api/hook" \
  -H "Content-Type: application/json" \
  -d "$INPUT" \
  --max-time 1 \
  > /dev/null 2>&1 || true
