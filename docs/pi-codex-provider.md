# Pi-Codex Provider — OpenAI OAuth Scenario

> status: draft
> created: 2026-02-18
> updated: 2026-02-18
> revision: 1

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** 아래는 이 스펙의 섹션 매핑.
> Tracking issue: #13

| Item | Section |
|------|---------|
| Task Checklist | §6 |
| Naming Conventions | §3.5 |
| State file | `docs/pi-codex-provider.state.md` |
| Decision Log | §8 (append-only) |
| Handoff Snapshot | §9 |
| Changelog | §10 |

<!-- ═══════════════════════════════════════════ -->
<!-- Fixed — Modify only on direction change    -->
<!-- ═══════════════════════════════════════════ -->

## 1. Goal

기존 `pi-ai` OAuth v2 작업과 분리하여, OpenAI OAuth 시나리오를 기준으로 동작하는 신규 provider `pi-codex`를 추가한다.

핵심 목표:
1. `pi-ai`와 책임을 분리한 `pi-codex` provider 신규 도입
2. OAuth 로그인/토큰 저장/자동 갱신 경로를 `pi-codex` key로 독립 운영
3. 기존 세션/명령/에이전트 흐름에서 회귀 없이 provider 확장

## 2. Non-Goals

- 기존 `pi-ai` provider 동작/정책 변경
- 기존 `codex`, `claude`, `gemini` provider 리팩토링
- 범용 OAuth 프레임워크 전면 재설계
- Discord auto-thread/provider 라우팅의 구조 변경
- 외부 서비스 의존성 추가

## 3. Design

### 3.1 Deliverables

| Deliverable | Path | Consumer | Format |
|-------------|------|----------|--------|
| Pi-Codex provider | `src/agents/providers/pi-codex.ts` | AgentSessionManager | TS module |
| Provider registration | `src/agents/index.ts`, bootstrapping entry | Runtime startup | TS updates |
| ProviderId extension | `src/agents/types.ts` | All providers | Type update |
| CLI provider expansion | `src/cli.ts` | OAuth login/status/logout | TS update |
| Env sample | `.env.example` | Runtime config | Doc/env update |
| Spec state tracker | `docs/pi-codex-provider.state.md` | SDD workflow | Markdown |
| Tests | `src/agents/providers/__tests__/pi-codex.test.ts`, `src/auth/__tests__/*` | CI/local | Bun tests |

### 3.2 Interface

```typescript
// src/agents/types.ts

export type ProviderId = 'codex' | 'claude' | 'gemini' | 'pi-ai' | 'pi-codex';
```

```typescript
// src/agents/providers/pi-codex.ts

import { Codex } from '@openai/codex-sdk';
import type { AgentProvider, AgentSession, ProviderCapabilities, ProviderId } from '../types.ts';
import { TokenStore } from '../../auth/token-store.ts';
import { DEFAULT_CALLBACK_PORT, type OAuthConfig } from '../../auth/oauth-pkce.ts';

export function loadPiCodexOAuthConfig(): OAuthConfig | null;

export class PiCodexProvider implements AgentProvider {
  readonly id: ProviderId;                 // 'pi-codex'
  readonly name: string;                   // 'Pi-Codex'
  async initialize(): Promise<void>;       // tokenStore('pi-codex') 우선 + API key fallback
  isAvailable(): boolean;                  // stored token or env key
  capabilities(): ProviderCapabilities;    // pi-ai baseline과 동일
  createSession(options: SessionOptions): Promise<AgentSession>;
}
```

```typescript
// src/cli.ts

export type OAuthProvider = 'pi-ai' | 'pi-codex';

export interface OAuthProviderEnvSpec {
  provider: OAuthProvider;
  authorizeUrlEnv: string;
  tokenUrlEnv: string;
  clientIdEnv: string;
  scopesEnv: string;
  callbackPortEnv: string;
}

export function getOAuthConfig(provider: OAuthProvider): OAuthConfig;
export function listSupportedOAuthProviders(): OAuthProvider[];
```

```typescript
// src/auth/token-store.ts (existing API reuse)

export class TokenStore {
  read(provider: string): TokenStoreEntry | null;
  write(provider: string, entry: TokenStoreEntry): void;
  delete(provider: string): void;
  getValidToken(provider: string, configLoader?: ConfigLoader): Promise<string | null>;
}
```

### 3.3 Flow

1. User runs `pray-bot login pi-codex`.
2. CLI resolves `pi-codex` env mapping and starts OAuth PKCE flow.
3. Tokens are stored to `~/.pray-bot/auth/pi-codex.json`.
4. `PiCodexProvider.initialize()` reads `pi-codex` token first.
5. If token is near-expiry, refresh with file lock.
6. If no token exists, fallback to `PICODEX_API_KEY`.
7. Session creation/runtime event mapping follows `PiAiSession` baseline.

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/agents/types.ts` | `ProviderId`에 `'pi-codex'` 추가 | Medium |
| `src/agents/index.ts` | `PiCodexProvider` export 추가 | Low |
| `src/cli.ts` | OAuth provider hardcode(`pi-ai`) 제거, `pi-codex` 추가 | Medium |
| `src/agents/providers/pi-ai.ts` | 변경 없음(회귀 방지) | Low |
| `.env.example` | `PICODEX_*` OAuth/API key env 추가 | Low |

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| class | `PiCodexProvider` | `pi-codex`용 AgentProvider 구현 |
| class | `PiCodexSession` | pi-codex turn stream/event adapter |
| function | `loadPiCodexOAuthConfig` | env 기반 OAuthConfig 로더 |
| type | `OAuthProvider` | `'pi-ai' | 'pi-codex'` |
| constant | `PICODEX_OAUTH_AUTHORIZE_URL` | OAuth authorize endpoint env |
| constant | `PICODEX_OAUTH_TOKEN_URL` | OAuth token endpoint env |
| constant | `PICODEX_OAUTH_CLIENT_ID` | OAuth client id env |
| constant | `PICODEX_API_KEY` | API key fallback env |
| file/module | `src/agents/providers/pi-codex.ts` | 신규 provider 모듈 |
| file | `docs/pi-codex-provider.state.md` | SDD task state file |

### 3.6 Security Considerations

- 입력 검증: OAuth callback의 `state`, `code`, `error` 필드 strict 검증
- 저장 보안: `~/.pray-bot/auth/pi-codex.json` 파일 권한 `0600`, 디렉토리 `0700`
- 신뢰 경계: 토큰 파일 파싱 실패 시 안전 실패(`null` or re-login required)
- 동시성: refresh path에서 provider별 lock file(`pi-codex.lock`) 사용
- 로그 보안: access/refresh token 원문 로그 금지

### 3.7 Target Environment

- Platform: macOS, Linux (Bun runtime)
- Runtime: Bun + TypeScript
- Deployment: CLI + pray-bot runtime provider

## 4. Verification Criteria

### Functional
- [ ] Given: `PICODEX_*` OAuth env가 모두 설정됨 / When: `pray-bot login pi-codex` / Then: OAuth 완료 후 `~/.pray-bot/auth/pi-codex.json` 저장
- [ ] Given: 저장된 `pi-codex` 토큰 유효 / When: `PiCodexProvider.initialize()` / Then: stored token으로 Codex client 초기화
- [ ] Given: 저장된 토큰 만료 + refresh 성공 / When: `initialize()` / Then: refresh 후 새 token 사용
- [ ] Given: 저장 토큰 없음 + `PICODEX_API_KEY` 설정 / When: `initialize()` / Then: API key fallback으로 정상 초기화
- [ ] Given: `pray-bot status pi-codex` / When: 인증 전/후 실행 / Then: 상태 메시지가 각각 Not authenticated/Authenticated로 출력

### Security/Negative
- [ ] Given: callback `state` 위조 / When: OAuth redirect 수신 / Then: 로그인 실패 + token 저장 없음
- [ ] Given: token file 손상(JSON parse 실패) / When: `isAvailable()`/`initialize()` / Then: 안전하게 미인증 처리 또는 re-login 유도
- [ ] Given: refresh 응답의 `expires_in`이 문자열 / When: token 파싱 / Then: 숫자 변환 후 `expiresAt`이 number로 저장

- [ ] No regression on existing features (`pi-ai`, `codex`, `claude`, `gemini`)

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `pi-ai`와 `pi-codex` env/토큰 키 충돌 | 인증 오동작 | env prefix/토큰 파일 키 분리 (`pi-ai`, `pi-codex`) |
| CLI provider 확장 중 하위호환 깨짐 | 기존 `pi-ai login` 실패 | `pi-ai` 회귀 테스트 유지 |
| OAuth endpoint 스펙 불일치 | 로그인 불가 | env 기반 endpoint override + mock 테스트 |
| 토큰 refresh 예외 처리 누락 | 런타임 초기화 실패 | fallback 정책 명시 + 회귀 테스트 추가 |

<!-- ═══════════════════════════════════════════ -->
<!-- Iterative — Updated each loop              -->
<!-- ═══════════════════════════════════════════ -->

## 6. Task Checklist

> Mark `[x]` only after verify passes.

- [ ] ✅ Step 1: `docs/pi-codex-provider.state.md` 생성 + 태스크 시드 작성 → verify: state file committed
- [ ] ⚠️ Step 2: `src/agents/types.ts`에 `pi-codex` 추가 → verify: `npx tsc --noEmit`
- [ ] ✅ Step 3: `src/agents/providers/pi-codex.ts` 신규 구현 (`pi-ai` baseline 재사용) → verify: provider unit tests
- [ ] ⚠️ Step 4: `src/cli.ts`를 multi-provider OAuth(`pi-ai`, `pi-codex`)로 확장 → verify: CLI parse/status tests
- [ ] ✅ Step 5: `.env.example`에 `PICODEX_*` 변수 추가 → verify: docs/env lint/manual check
- [ ] ⚠️ Step 6: 회귀 보강 테스트 추가 (`PIAI_API_KEY fallback`, `expires_in string`) → verify: `bun test`
- [ ] ⚠️ Step 7: 전체 검증 (`bun test`, `npx tsc --noEmit`) 및 issue 업데이트 → verify: issue checklist sync

## 7. Open Questions

- `pi-codex` 기본 base URL을 고정할지(`PICODEX_BASE_URL`) 필수 env로 둘지
- `pi-codex`가 `pi-ai`와 capability matrix를 완전히 동일하게 둘지
- `pi-codex` provider id를 외부 노출 명칭(`pi-codex`)으로 고정할지 별칭 허용할지

<!-- ═══════════════════════════════════════════ -->
<!-- Cumulative — Append-only, never delete     -->
<!-- ═══════════════════════════════════════════ -->

## 8. Decision Log

- 2026-02-18: `pi-ai` OAuth v2 작업과 분리된 새 이슈(#13) + 새 스펙으로 진행.
- 2026-02-18: 인증 저장 키를 provider별(`pi-ai`, `pi-codex`)로 분리하기로 결정.

## 9. Handoff Snapshot

- Branch baseline: `feature/pi-ai-oauth-v2`
- Tracking issue: #13
- Next action: state file 생성 후 Step 2~3 구현 착수

## 10. Changelog

| rev | date | summary |
|-----|------|---------|
| 1 | 2026-02-18 | Initial draft |
