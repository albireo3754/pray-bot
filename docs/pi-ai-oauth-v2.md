# Pi-AI OAuth PKCE v2

> status: draft
> created: 2026-02-18
> updated: 2026-02-18
> revision: 2

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** 아래는 이 스펙의 섹션 매핑.

| Item | Section |
|------|---------|
| Task Checklist | §6 |
| Naming Conventions | §3.5 |
| State file | `docs/pi-ai-oauth-v2.state.md` |
| Decision Log | §8 (append-only) |
| Handoff Snapshot | §9 |
| Changelog | §10 |

<!-- ═══════════════════════════════════════════ -->
<!-- Fixed — Modify only on direction change    -->
<!-- ═══════════════════════════════════════════ -->

## 1. Goal

Pi-AI 프로바이더의 인증을 API key 방식(v1)에서 **OAuth PKCE + token refresh**(v2)로 업그레이드한다.
OpenClaw의 인증 패턴을 따라 구현한다.

구체적으로:
1. **CLI `pray-bot login pi-ai`** — 브라우저 기반 OAuth PKCE 로그인
2. **Token persistence** — `~/.pray-bot/auth/pi-ai.json`에 토큰 저장
3. **Auto refresh** — 만료 전 자동 갱신 (file lock으로 race condition 방지)
4. **PiAiProvider v2** — 저장된 토큰 우선, `PIAI_API_KEY` fallback

## 2. Non-Goals

- 다른 프로바이더(Codex, Claude, Gemini)에 OAuth 적용
- Multi-agent credential inheritance (OpenClaw의 agent별 분리 구조)
- Doctor/repair 진단 커맨드
- 기존 코드 리팩토링
- 범용 OAuth 프레임워크 구축 — Pi-AI 전용으로 충분

## 3. Design

### 3.1 Deliverables

| Deliverable | Path | Consumer | Format |
|-------------|------|----------|--------|
| OAuth PKCE module | `src/auth/oauth-pkce.ts` | CLI, PiAiProvider | TS module |
| Token store | `src/auth/token-store.ts` | PiAiProvider, CLI | TS module |
| CLI entry point | `src/cli.ts` | User terminal | Bun executable |
| Updated Pi-AI provider | `src/agents/providers/pi-ai.ts` | AgentSessionManager | TS module |
| Auth module index | `src/auth/index.ts` | Re-exports | TS barrel |

### 3.2 Interface

```typescript
// src/auth/oauth-pkce.ts

export interface OAuthConfig {
  authorizeUrl: string;    // e.g., "https://auth.pi-ai.com/oauth/authorize"
  tokenUrl: string;        // e.g., "https://auth.pi-ai.com/oauth/token"
  clientId: string;
  scopes: string[];
  callbackPort: number;    // localhost callback server port (default: 19284)
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;       // Unix epoch seconds
  accountId?: string;      // Extracted from JWT if available
}

export interface PKCEChallenge {
  verifier: string;        // Random 43-128 char base64url string
  challenge: string;       // SHA-256 hash of verifier, base64url encoded
  state: string;           // Random state for CSRF protection
}

/** Generate PKCE verifier + challenge + state */
export function generatePKCE(): PKCEChallenge;

/**
 * Full OAuth PKCE login flow:
 * 1. Generate PKCE challenge
 * 2. Start localhost callback server
 * 3. Open browser to authorize URL
 * 4. Wait for redirect with auth code
 * 5. Exchange code for tokens
 * 6. Return tokens
 */
export async function loginWithPKCE(config: OAuthConfig): Promise<OAuthTokens>;

/** Exchange refresh token for new access token */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens>;
```

```typescript
// src/auth/token-store.ts

export interface TokenStoreEntry {
  provider: string;        // "pi-ai"
  tokens: OAuthTokens;
  config: OAuthConfig;     // Saved for refresh
  updatedAt: string;       // ISO 8601
}

/**
 * File-based token store at ~/.pray-bot/auth/<provider>.json
 * Follows OpenClaw pattern: file locking for concurrent access.
 */
export class TokenStore {
  constructor(private baseDir?: string);  // Default: ~/.pray-bot/auth

  /** Read stored tokens. Returns null if not found or file missing. */
  read(provider: string): TokenStoreEntry | null;

  /** Write tokens atomically. Creates directory if needed. */
  write(provider: string, entry: TokenStoreEntry): void;

  /** Delete stored tokens. */
  delete(provider: string): void;

  /**
   * Get valid access token. Auto-refreshes if expired.
   * Uses file lock during refresh to prevent race conditions.
   * Returns null if no stored tokens or refresh fails.
   */
  getValidToken(provider: string): Promise<string | null>;
}
```

```typescript
// src/cli.ts

export type CLICommand =
  | { kind: 'login'; provider: string }
  | { kind: 'status'; provider: string }
  | { kind: 'logout'; provider: string }
  | { kind: 'help' };

/** Parse process.argv into a typed command. Throws on invalid input. */
export function parseArgs(argv: string[]): CLICommand;

/** Execute a parsed CLI command. Entry point: parseArgs → runCommand. */
export async function runCommand(cmd: CLICommand): Promise<void>;
```

### 3.3 Flow

**Login Flow (`pray-bot login pi-ai`)**

```
CLI argv parse
  → "login" + "pi-ai" detected
  → Load Pi-AI OAuth config (env vars or defaults)
  → generatePKCE() → { verifier, challenge, state }
  → Start Bun.serve() on localhost:19284
  → Build authorize URL with: client_id, redirect_uri, code_challenge, state, scope
  → Open browser (macOS: `open <url>`)
  → Print: "Waiting for authorization... (press Ctrl+C to cancel)"
  → Browser: user logs in → redirect to localhost:19284/callback?code=XXX&state=YYY
  → Verify state matches
  → POST token URL with: code, code_verifier, client_id, redirect_uri, grant_type
  → Receive: { access_token, refresh_token, expires_in }
  → Save to ~/.pray-bot/auth/pi-ai.json via TokenStore
  → Print: "Logged in successfully!"
  → Shutdown callback server + exit
```

**Token Refresh Flow (in PiAiProvider.initialize)**

```
PiAiProvider.initialize()
  → tokenStore.getValidToken("pi-ai")
    → Read ~/.pray-bot/auth/pi-ai.json
    → If not found → fallback to PIAI_API_KEY
    → If found + not expired → return accessToken
    → If found + expired:
      → Acquire file lock (~/.pray-bot/auth/pi-ai.lock)
      → Re-read file (another process may have refreshed)
      → If still expired → POST refresh_token to token URL
        → Success → Save new tokens → release lock → return new accessToken
        → Failure → release lock → log error → throw "Re-login required"
  → new Codex({ apiKey: resolvedToken, baseURL: ... })
```

**Provider Availability (`isAvailable`)**

```
isAvailable()
  → tokenStore.read("pi-ai") !== null  ← 저장된 토큰 있음
  → OR process.env.PIAI_API_KEY         ← 기존 API key fallback
```

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/agents/providers/pi-ai.ts` | `initialize()`, `isAvailable()` 수정 — 토큰 스토어 우선, API key fallback | Medium |
| `package.json` | `bin` 필드 추가 | Low |
| `.env.example` | Pi-AI OAuth config 변수 추가 | Low |

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| module | `src/auth/oauth-pkce.ts` | OAuth PKCE flow (generate, login, refresh) |
| module | `src/auth/token-store.ts` | File-based token persistence with lock |
| module | `src/cli.ts` | CLI entry point (argv parse → subcommand dispatch) |
| class | `TokenStore` | ~/.pray-bot/auth/ 기반 토큰 저장/조회/갱신 |
| function | `generatePKCE()` | PKCE verifier + challenge + state 생성 |
| function | `loginWithPKCE(config)` | Full browser-based OAuth PKCE login |
| function | `refreshAccessToken(config, refreshToken)` | Refresh token → new access token |
| constant | `DEFAULT_CALLBACK_PORT` | `19284` — localhost callback 포트 |
| constant | `AUTH_DIR` | `~/.pray-bot/auth` — 토큰 저장 디렉토리 |
| file | `~/.pray-bot/auth/pi-ai.json` | Pi-AI 토큰 저장 파일 |
| file | `~/.pray-bot/auth/pi-ai.lock` | Refresh 시 file lock |
| env | `PIAI_OAUTH_AUTHORIZE_URL` | OAuth authorize endpoint |
| env | `PIAI_OAUTH_TOKEN_URL` | OAuth token endpoint |
| env | `PIAI_OAUTH_CLIENT_ID` | OAuth client ID |
| env | `PIAI_OAUTH_SCOPES` | OAuth scopes (comma-separated) |

## 4. Verification Criteria

- [ ] Given: No stored tokens, no `PIAI_API_KEY` / When: `pray-bot login pi-ai --status` / Then: "Not authenticated" 출력
- [ ] Given: Valid stored tokens in `~/.pray-bot/auth/pi-ai.json` / When: `pray-bot login pi-ai --status` / Then: "Authenticated (expires: ...)" 출력
- [ ] Given: `pray-bot login pi-ai` 실행 / When: 브라우저에서 인증 완료 → localhost callback / Then: 토큰이 `~/.pray-bot/auth/pi-ai.json`에 저장, "Logged in successfully!" 출력
- [ ] Given: Stored tokens expired, refresh_token valid / When: `PiAiProvider.initialize()` / Then: 자동 갱신 후 새 access_token 사용
- [ ] Given: Stored tokens expired, refresh 실패 / When: `PiAiProvider.initialize()` / Then: 에러 로깅 + throw "Re-login required: run `pray-bot login pi-ai`"
- [ ] Given: Stored tokens valid / When: `PiAiProvider.isAvailable()` / Then: `true`
- [ ] Given: No stored tokens, `PIAI_API_KEY` set / When: `PiAiProvider.isAvailable()` / Then: `true` (backward compatible)
- [ ] Given: `pray-bot login pi-ai --logout` / When: 실행 / Then: `~/.pray-bot/auth/pi-ai.json` 삭제, "Logged out" 출력
- [ ] Given: `generatePKCE()` 호출 / When: 결과 검사 / Then: verifier 길이 43-128, challenge = base64url(SHA-256(verifier)), state는 non-empty random string
- [ ] Given: OAuth callback에서 state가 원본과 불일치 / When: callback 수신 / Then: "State mismatch" 에러 + callback server 종료
- [ ] Given: Callback server 포트(19284) 이미 사용 중 / When: `pray-bot login pi-ai` / Then: "Port 19284 already in use" 에러 메시지 출력
- [ ] Given: Token exchange 네트워크 실패 / When: auth code → token POST / Then: 에러 로깅 + "Token exchange failed" 메시지 출력
- [ ] Given: Stored tokens의 refresh_token이 서버에서 거부 / When: `getValidToken()` / Then: 에러 로깅 + throw "Re-login required"
- [ ] No regression: 기존 `PIAI_API_KEY` 방식이 그대로 동작

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pi-AI OAuth 엔드포인트가 아직 확정 안 됨 | 구현은 가능하나 실제 테스트 불가 | 엔드포인트를 env var로 설정 가능하게. 테스트는 mock으로 |
| File lock이 프로세스 crash 시 남을 수 있음 | Refresh 블로킹 | Lock file에 timeout (5초) + stale lock 자동 정리 |
| Callback server 포트 충돌 | Login 실패 | 포트 사용 중이면 에러 메시지 + 대안 안내 |

<!-- ═══════════════════════════════════════════ -->
<!-- Iterative — Updated each loop              -->
<!-- ═══════════════════════════════════════════ -->

## 6. Task Checklist

> Mark `[x]` only after verify passes.

- [x] ✅ Step 1: Create `src/auth/oauth-pkce.ts` — `generatePKCE()`, `loginWithPKCE()`, `refreshAccessToken()` → verify: `bun test src/auth/oauth-pkce.test.ts` passes (PKCE generation + mock token exchange)
- [x] ✅ Step 2: Create `src/auth/token-store.ts` — `TokenStore` class with read/write/delete/getValidToken + file locking → verify: `bun test src/auth/token-store.test.ts` passes (CRUD + lock + auto-refresh)
- [x] ✅ Step 3: Create `src/auth/index.ts` — barrel exports → verify: `import { TokenStore, loginWithPKCE } from '../auth'` resolves
- [x] ✅ Step 4: Create `src/cli.ts` — argv parsing, `login <provider>` / `--status` / `--logout` subcommands → verify: `bun src/cli.ts login pi-ai --status` prints status
- [x] ✅ Step 5: Add `bin` field to `package.json` → verify: `bun link && pray-bot --help` works
- [x] ⚠️ Step 6: Update `src/agents/providers/pi-ai.ts` — `initialize()` uses TokenStore first, `isAvailable()` checks stored tokens → verify: `bun test src/agents/providers/__tests__/pi-ai.test.ts` passes + 기존 API key 방식 동작 확인
- [x] ✅ Step 7: Update `.env.example` — Pi-AI OAuth config 변수 추가 → verify: 파일에 `PIAI_OAUTH_*` 변수 존재
- [x] ✅ Step 8: Integration test — full login flow with mock OAuth server → verify: `bun test src/auth/__tests__/integration.test.ts` passes

## 7. Open Questions

- Pi-AI OAuth 엔드포인트 URL이 확정되면 기본값으로 설정 (현재는 env var 필수)
- Pi-AI의 `client_id`가 공개 값인지, 사용자별 발급인지 확인 필요

## 8. Decision Log

| # | Date | Decision | Rationale |
|---|------|----------|-----------|
| 1 | 2026-02-18 | OpenClaw 패턴 따름 (file lock, token store) | 사용자 요청. 검증된 패턴 |
| 2 | 2026-02-18 | `~/.pray-bot/auth/` 에 토큰 저장 | Codex의 `~/.codex/` 패턴과 일관성 |
| 3 | 2026-02-18 | `PIAI_API_KEY` fallback 유지 | Backward compatibility |
| 4 | 2026-02-18 | bin 등록으로 `pray-bot` CLI | 사용자 선택 |

## 9. Handoff Snapshot

## 10. Changelog

| rev | date | summary |
|-----|------|---------|
| 1 | 2026-02-18 | Initial draft |
| 2 | 2026-02-18 | Review 반영: CLI 타입 정의, 에러 케이스 5개 추가, refresh 실패 시 throw+log 확정, PKCE 검증 기준 |
