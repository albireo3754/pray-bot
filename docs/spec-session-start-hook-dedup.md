# Spec: SessionStart Hook — Discord Route 중복 Auto-Thread 방지

## 버그 요약

Discord `/claude` 명령으로 세션을 시작하면 auto-thread가 중복 생성된다.

## 원인

### 타이밍 갭

```
T0: /claude 명령
    → getOrCreateDiscordThreadForProvider()
    → discordThreadRoutes.set('thread-A', { providerSessionId: '', cwd: '/path/proj' })
    → Claude 프로세스 spawn

T1: SessionStart hook 수신 (session_id='sess-xxx', cwd='/path/proj')
    → onSessionStart(snapshot)
    → isAlreadyMapped('sess-xxx') 체크
         → discoveredMap: 없음
         → threadRoutes 순회: providerSessionId='' ≠ 'sess-xxx' → 매칭 실패
    → auto-thread 생성 ← 중복!

T2: Claude stdout 첫 JSON line 출력
    → onSession() 콜백
    → route.providerSessionId = 'sess-xxx'  ← 뒤늦게 세팅
```

**핵심**: SessionStart hook은 Claude stdout보다 항상 먼저 도착한다.
따라서 hook 수신 시점에 `route.providerSessionId`는 항상 `''` 상태.
`isAlreadyMapped`가 session_id로 매칭을 시도해도 route에서 찾지 못한다.

### SessionStart payload

```json
{
  "hook_event_name": "SessionStart",
  "session_id": "3a61ecc8-149e-403a-b8df-10a2027d723c",
  "cwd": "/Users/pray/work/js/pray-bot",
  "transcript_path": "/Users/pray/.claude/projects/-.../3a61ecc8-....jsonl",
  "source": "startup"
}
```

- `session_id`: 정상적으로 UUID가 전달됨 (빈 값 아님)
- `transcript_path`: basename에서 `.jsonl` 제거 = `session_id` (동일값)
- `model`, `permission_mode`: 문서와 달리 실제로는 포함되지 않음

## 해결 방법: `claimRouteBySessionId`

`onSessionStart` 진입 시 `threadRoutes`에서 **`providerSessionId=''` AND `cwd` 일치** 인
non-auto discord route를 찾아 `providerSessionId`를 선점 등록한다.

이후 `isAlreadyMapped`가 정상적으로 매칭 → auto-thread 생성 스킵.

### 수정된 플로우

```
T1: SessionStart hook 수신 (session_id='sess-xxx', cwd='/path/proj')

    claimRouteBySessionId('sess-xxx', '/path/proj', 'claude')
      → threadRoutes 순회
      → { providerSessionId: '', autoDiscovered: false, cwd: '/path/proj' } 발견
      → route.providerSessionId = 'sess-xxx'  ← 선점

    isAlreadyMapped('sess-xxx')
      → threadRoutes: providerSessionId='sess-xxx' 매칭 성공 → true
    → auto-thread 생성 스킵 ✓
```

### 구현 위치

`src/auto-thread/index.ts` — `AutoThreadDiscovery` 클래스

- `claimRouteBySessionId(sessionId, cwd, provider): boolean` — private 메서드
- `onSessionStart()` 진입부에서 호출

## 엣지 케이스

### 같은 cwd에서 동시에 여러 `/claude` 실행

```
route-A: { cwd: '/proj', providerSessionId: '' }
route-B: { cwd: '/proj', providerSessionId: '' }

SessionStart(sess-1, cwd='/proj') → route-A에 선점
SessionStart(sess-2, cwd='/proj') → route-B에 선점
```

첫 번째 빈 route를 순서대로 가져가므로 각 session이 별도 route에 매핑된다.
동시에 같은 cwd에서 여러 `/claude`를 실행하는 케이스는 현실적으로 드물어 허용 범위.

### 순수 terminal 실행 (discord route 없음)

```
claimRouteBySessionId → 매칭 없음 → false 반환
isAlreadyMapped → false
→ auto-thread 생성 ✓ (정상)
```

### resume (댓글)

```
route: { providerSessionId: 'sess-xxx' }  ← 이미 설정됨

SessionStart(sess-xxx, source='resume') 도착
claimRouteBySessionId → providerSessionId 비어있지 않음 → 스킵
isAlreadyMapped('sess-xxx') → 매칭 성공 → true
→ auto-thread 생성 안 함 ✓
```

### onMonitorRefresh와의 관계

`onSessionStart` (hook 기반) — fast path, 즉시 판단
`onMonitorRefresh` (JSONL 기반) — 정확한 발견, 주기적으로 보완

- discord route 있는 경우: `claimRouteBySessionId`로 선점 → 양쪽 모두 스킵
- terminal 실행: `onSessionStart`가 즉시 auto-thread 생성
- `onSessionStart` 실패 시: `onMonitorRefresh`가 다음 주기에 fallback 커버

## 테스트

`src/auto-thread/__tests__/discord-session-then-comment.test.ts`

| 케이스 | 설명 | 기대 |
|--------|------|------|
| `fix: providerSessionId="" claimed by cwd` | discord route 있고 providerSessionId='' | createThread 0회, route.providerSessionId 선점됨 |
| `resume: no auto-thread after comment` | providerSessionId 설정 후 resume | createThread 0회 |
| `race: concurrent onSessionStart + onMonitorRefresh` | 동시 실행 | createThread ≤1회 |
| `normal: no discord route` | terminal 실행, discord route 없음 | createThread 1회 |
| `normal: dedup via discoveredMap` | 동일 세션 두 번 호출 | createThread 1회 |
