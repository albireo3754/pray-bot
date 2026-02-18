# Web Session Monitor — Spec Tracker + Live Dashboard

> status: draft
> created: 2026-02-18
> updated: 2026-02-18
> revision: 4

<!-- ═══════════════════════════════════════════════════ -->
<!-- LLM Work Guide — Instructions for implementing LLM -->
<!-- ═══════════════════════════════════════════════════ -->

## 0. LLM Work Guide

> `.state.md` 워크플로우, 세션 복원/종료 절차는 CLAUDE.md "Spec-Driven Task Workflow" 섹션을 따른다.
> 이 스펙 고유 사항만 아래에 기술.

- State file: `docs/web-session-monitor.state.md`
- §3.5 Naming Conventions의 이름을 그대로 사용할 것
- Design decision 발생 시 §8에 append

| Item | Section |
|------|---------|
| Task Checklist | §6 |
| Naming Conventions | §3.5 |
| State file | `docs/web-session-monitor.state.md` |
| Decision Log | §8 |
| Handoff Snapshot | §9 |
| Changelog | §10 |

<!-- ═══════════════════════════════════════════ -->
<!-- Fixed — Modify only on direction change    -->
<!-- ═══════════════════════════════════════════ -->

## 1. Goal

Spec-Driven Development(SDD)에서 스펙 문서 작업은 장시간 핑퐁(작성 → 리뷰 → 수정 → 리뷰)이 반복된다. 현재 문제:

| 문제 | 상세 |
|------|------|
| **스펙 목록 파악 불가** | `.state.md`가 여러 프로젝트/worktree에 흩어져 있어 "지금 뭘 작업중인지" 한눈에 안 보임 |
| **세션 ↔ 스펙 연결 없음** | Claude 세션이 어떤 스펙을 실행중인지 알 수 없음 |
| **웹 뷰 없음** | 스펙 진행률을 브라우저에서 실시간으로 볼 수 없음 |
| **Discord 스펙 알림 없음** | 스펙 task 완료, review 점수 등이 Discord에 안 옴 |
| **세션 끊김 시 컨텍스트 유실** | 스펙 핑퐁 중 세션이 끊기면 Discord thread에 이력이 없음 |

이 스펙은 pray-bot에 3가지 기능을 추가한다:

1. **Spec Registry** — `.state.md` 파일을 스캔/파싱하여 활성 스펙 목록 + 진행률 관리
2. **HTTP API + Web Dashboard** — 브라우저에서 스펙 진행률을 실시간으로 볼 수 있는 localhost 대시보드
3. **Discord 연동** — 스펙 이벤트(task 완료, review, 세션 연결)를 Discord thread에 포스팅

**외부 도구 참고:**
- [Augment Intent](https://www.augmentcode.com/product/intent): "Living Spec" — 스펙이 에이전트 작업 결과를 반영해서 자동 업데이트, Coordinator 대시보드
- [GitHub spec-kit](https://github.com/github/spec-kit): 구조화된 스펙 폴더 + CLI slash command, phase gate
- [Amazon Kiro](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html): IDE 내 Requirements → Design → Tasks 3단계 뷰, task별 status UI

이 도구들의 핵심 아이디어(living spec dashboard, spec-as-source-of-truth, real-time progress tracking)를 pray-bot 로컬 환경에 맞게 구현한다.

## 2. Non-Goals

- spec/lite-spec 스킬 자체 수정 (기존 스킬은 그대로 유지)
- .state.md 파일 포맷 변경 (기존 포맷 파싱만 함)
- 스펙 편집 UI (웹에서 스펙을 수정하는 것은 범위 밖 — 읽기 전용)
- 외부 서비스(GitHub, Jira) 연동
- 인증/멀티유저 (로컬 전용, single user)
- Codex 세션 스펙 연동 (Claude 세션 전용, 향후 확장 가능)
- CI/CD 파이프라인 연동
- .state.md의 `> status:` 메타데이터 파싱 (현재 작업 중인 state만 관심)
- .state.md의 `## Backlog Queue` 섹션 파싱 (범위 밖)

## 3. Design

### 3.1 Deliverables

| # | Deliverable | Path | Format |
|---|-------------|------|--------|
| D1 | Spec state parser | `src/spec-tracker/parser.ts` | `.state.md` → `SpecState` 파서 (새 파일) |
| D2 | Spec scanner | `src/spec-tracker/scanner.ts` | 파일시스템 스캔 → 활성 스펙 수집 (새 파일) |
| D3 | Spec registry | `src/spec-tracker/registry.ts` | 인메모리 스펙 상태 관리 + file watcher (새 파일) |
| D4 | Spec types | `src/spec-tracker/types.ts` | 타입 정의 (새 파일) |
| D5 | HTTP API routes | `src/spec-tracker/routes.ts` | REST API 엔드포인트 (새 파일) |
| D6 | Web dashboard HTML | `src/spec-tracker/dashboard.ts` | Component function 패턴 HTML 생성 (새 파일) |
| D7 | Discord formatter | `src/spec-tracker/discord-formatter.ts` | 스펙 이벤트 Discord 메시지/임베드 포맷 (새 파일) |
| D8 | Plugin entry | `src/spec-tracker/plugin.ts` | `PrayBotPlugin` 구현 (새 파일) |
| D9 | Module index | `src/spec-tracker/index.ts` | Re-exports (새 파일) |
| D10 | Tests | `src/spec-tracker/__tests__/*.test.ts` | Unit tests (새 파일들) |

### 3.2 Interface

#### 3.2.1 Types (`src/spec-tracker/types.ts`)

```typescript
/** .state.md에서 파싱한 개별 task */
export interface SpecTask {
  index: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  agent: string | null;
  startedAt: string | null;   // ISO date string
  completedAt: string | null;
}

/** .state.md에서 파싱한 스펙 전체 상태 */
export interface SpecState {
  /** 스펙 제목 (state.md 첫 번째 heading에서 추출) */
  title: string;
  /** 연결된 스펙 파일 경로 (state.md 헤더의 `spec:` 필드) */
  specPath: string | null;
  /** state.md 파일 절대 경로 */
  statePath: string;
  /** 생성일 */
  createdAt: string | null;
  /** 마지막 업데이트 */
  updatedAt: string | null;
  /** task 목록 */
  tasks: SpecTask[];
  /** 의존성 분석 텍스트 (원문) */
  dependencyAnalysis: string | null;
  /** 세션 로그 (원문) */
  sessionLog: string | null;
}

/** Registry가 관리하는 스펙 엔트리 */
export interface SpecEntry {
  /**
   * 식별자 — SHA-256 hash 기반 URL-safe ID.
   * 생성 규칙: createHash('sha256').update(absoluteStatePath).digest('base64url').slice(0, 16)
   *   (node:crypto. 96bit entropy → 충돌 확률 무시 가능)
   * 주의: Buffer.from(path).toString('base64url').slice(N) 방식은 동일 디렉토리 내 파일의
   *   공통 prefix를 공유하여 ID 충돌을 보장하므로 사용 금지.
   */
  id: string;
  /** 스펙 제목 */
  title: string;
  /** 스펙 파일 경로 (SPEC.md) — null이면 state.md만 존재 */
  specPath: string | null;
  /** state.md 절대 경로 */
  statePath: string;
  /** 스펙이 속한 프로젝트 경로 */
  projectPath: string;
  /** 프로젝트 이름 */
  projectName: string;
  /** 전체 상태 요약 */
  status: 'draft' | 'in_progress' | 'completed' | 'stale';
  /** 진행률 */
  progress: { done: number; total: number; percent: number };
  /** task 목록 */
  tasks: SpecTask[];
  /** 연결된 Claude 세션 ID (있으면) */
  linkedSessionId: string | null;
  /** 마지막 state.md 수정 시각 */
  lastModified: Date;
  /** worktree 정보 (있으면) */
  worktree: { name: string; originalProject: string } | null;
}

/** 전체 Registry 스냅샷 */
export interface SpecRegistrySnapshot {
  specs: SpecEntry[];
  activeCount: number;
  completedCount: number;
  totalTasks: { done: number; total: number };
  lastScan: Date;
}

/** 스펙 이벤트 (Discord 알림용) */
export type SpecEvent =
  | { type: 'task_completed'; specId: string; task: SpecTask; progress: SpecEntry['progress'] }
  | { type: 'spec_completed'; specId: string; title: string }
  | { type: 'spec_started'; specId: string; title: string }
  | { type: 'session_linked'; specId: string; sessionId: string }
  | { type: 'spec_stale'; specId: string; title: string; staleSince: Date };
```

#### 3.2.2 State Parser (`src/spec-tracker/parser.ts`)

```typescript
/**
 * .state.md 파일 내용을 파싱하여 SpecState를 반환.
 *
 * 파싱 대상 포맷 (기존 /sisyphus가 생성하는 형태):
 *
 * ```markdown
 * # Title — Task State
 * > spec: path/to/spec.md | created: 2026-02-18 | updated: 2026-02-18
 *
 * ## Dependency Analysis
 * ...
 *
 * ## Tasks
 * | # | Task | Status | Agent | Started | Completed |
 * |---|------|--------|-------|---------|-----------|
 * | 1 | Do X | completed | — | 2026-02-18 | 2026-02-18 |
 * | 2 | Do Y | in_progress | sisyphus | 2026-02-18 | — |
 * | 3 | Do Z | pending | — | — | — |
 *
 * ## Session Log
 * ...
 * ```
 *
 * 파싱 규칙:
 * - `> spec:` 라인의 pipe-separated 메타데이터 추출
 * - Task 테이블: `|` 구분, Status 컬럼 값이 'completed'|'in_progress'|'pending'|'blocked' 중 하나
 * - Agent 값 "—" 또는 "-" → null
 * - Started/Completed 값 "—" 또는 "-" → null
 * - `## Backlog Queue` 등 미지원 섹션은 무시 (에러 없이 skip)
 * - 파싱 실패 시 빈 tasks 반환, 에러 로그만 출력
 */
export function parseStateFile(content: string): SpecState;

/**
 * .state.md 파일 경로에서 직접 읽어 파싱.
 * 파일이 없으면 null 반환.
 */
export async function parseStateFilePath(filePath: string): Promise<SpecState | null>;
```

#### 3.2.3 Scanner (`src/spec-tracker/scanner.ts`)

```typescript
import { homedir } from 'node:os';

export interface ScanConfig {
  /** 스캔할 루트 디렉토리들 (기본: ['~/work', '~/worktrees']) */
  roots: string[];
  /** 제외할 경로 패턴 (glob) */
  excludePatterns: string[];
  /** .state.md 파일명 패턴 (기본: '*.state.md') */
  stateFilePattern: string;
  /** 최대 디렉토리 깊이 (기본: 5) */
  maxDepth: number;
}

/**
 * 지정된 루트 디렉토리들에서 .state.md 파일을 찾아 경로 목록 반환.
 *
 * 구현 디테일:
 * - roots의 `~`를 `os.homedir()`로 확장 (Bun.Glob은 ~ 미지원)
 * - roots를 `fs.realpathSync()`로 canonical화 (symlink escape 방어)
 * - Bun.Glob('**\/*.state.md') 사용
 * - maxDepth 적용: glob 결과에서 root 기준 path segment 수로 필터링
 *   예) maxDepth=5 → root/a/b/c/d/e/foo.state.md (5 depth) ✅
 *                   → root/a/b/c/d/e/f/foo.state.md (6 depth) ❌
 * - excludePatterns: glob 결과에 대해 post-filter (Bun.Glob negative pattern 제한적)
 * - glob 결과 각 경로를 realpathSync() 후 canonical roots와 prefix 비교.
 *   canonical roots 외부를 가리키는 경로(symlink 경유 포함)는 제외 + 로그 경고
 */
export async function scanForStateFiles(config: ScanConfig): Promise<string[]>;

/**
 * state.md 경로로부터 프로젝트 정보 추출.
 * ~/work/js/pray-bot/docs/foo.state.md → { projectPath: '~/work/js/pray-bot', projectName: 'pray-bot' }
 * ~/worktrees/feat/gate/docs/bar.state.md → { projectPath: '...', worktree: { name: 'feat', ... } }
 */
export function extractProjectInfo(statePath: string): {
  projectPath: string;
  projectName: string;
  worktree: { name: string; originalProject: string } | null;
};
```

#### 3.2.4 Registry (`src/spec-tracker/registry.ts`)

```typescript
export interface SpecRegistryConfig {
  /** 스캔 설정 */
  scan: ScanConfig;
  /** 자동 리프레시 주기 (ms). 0이면 수동만. 기본: 30_000 (30초) */
  refreshIntervalMs: number;
  /** stale 판정 시간 (ms). 기본: 86_400_000 (24시간) */
  staleThresholdMs: number;
  /** 이벤트 콜백 (Discord 알림용) */
  onEvent?: (event: SpecEvent) => void;
}

export class SpecRegistry {
  constructor(config: SpecRegistryConfig);

  /** 즉시 스캔 + 파싱. 모든 .state.md를 다시 읽음. */
  async refresh(): Promise<SpecRegistrySnapshot>;

  /** 현재 스냅샷 (마지막 refresh 결과) */
  getSnapshot(): SpecRegistrySnapshot;

  /** 특정 스펙 조회 */
  getSpec(specId: string): SpecEntry | null;

  /** Claude 세션 ID와 스펙 연결 */
  linkSession(specId: string, sessionId: string): void;

  /** 자동 리프레시 시작 (setInterval) */
  startAutoRefresh(): void;

  /** 자동 리프레시 중지 */
  stopAutoRefresh(): void;

  /** file watcher 시작 — state.md 변경 시 해당 파일만 재파싱 */
  startFileWatcher(): void;

  /** file watcher 중지 */
  stopFileWatcher(): void;

  /**
   * 동시성 계약:
   * - refresh()와 file watcher 콜백은 직렬 실행 (_refreshing flag).
   *   refresh 진행 중에 watcher 이벤트 수신 시 _pendingRefresh = true 후 즉시 반환.
   *   refresh 완료 후 _pendingRefresh가 true이면 한 번 더 실행.
   * - file watcher 이벤트 500ms debounce (빠른 연속 write 병합).
   * - 이벤트 중복 suppression:
   *   Map<string, number> (서명 → timestamp ms). 서명 = `${specId}:${type}:${taskIndex}`.
   *   동일 서명이 30초 내 존재하면 onEvent skip.
   *   이벤트 처리마다 만료(>30초) 항목 일괄 삭제 (lazy GC, 별도 타이머 없음).
   * - file watcher 감시 대상 최대 50개. 초과 시 최근 수정된 50개 우선.
   *   초과 발생 시 로그 경고: "N state.md found, watching 50 most recent"
   */
}
```

#### 3.2.5 HTTP API Routes (`src/spec-tracker/routes.ts`)

```typescript
import type { RouteDefinition } from '../plugin/types.ts';

/**
 * 스펙 트래커 HTTP 라우트 생성.
 *
 * Endpoints:
 *
 * GET /api/specs
 *   → SpecRegistrySnapshot (모든 활성 스펙)
 *   Query: ?status=in_progress|completed|draft|stale
 *          &project=pray-bot
 *
 * GET /api/specs/:id
 *   → SpecEntry 상세 (task breakdown 포함)
 *
 * GET /api/specs/:id/content
 *   → { spec: string, state: string }
 *   스펙 파일 + state.md 원문 (markdown)
 *   경로 검증 (path traversal 방어):
 *     1. rawSpecPath = state.md 내 `> spec:` 필드 값
 *     2. resolved = path.resolve(path.dirname(statePath), rawSpecPath)
 *        (rawSpecPath가 절대경로면 그대로)
 *     3. canonical = fs.realpathSync(resolved)  // symlink 해소
 *        ENOENT (파일 없음/dangling symlink) → 404 { error: "spec file not found" }
 *     4. roots = scanRoots.map(r => fs.realpathSync(r))
 *     5. roots.some(r => canonical.startsWith(r + '/')) 검사
 *     6. 검증 실패 → 403 { error: "path outside scan boundary" }
 *   Note: realpathSync 없이 문자열 prefix 비교만 하면 symlink escape 가능
 *
 * POST /api/specs/refresh
 *   → SpecRegistrySnapshot (강제 리프레시)
 *
 * POST /api/specs/:id/link-session
 *   Body: { sessionId: string }
 *   Body validation:
 *     - Content-Type !== 'application/json' → 415 { error: "Content-Type must be application/json" }
 *     - JSON parse 실패 → 400 { error: "invalid JSON" }
 *     - typeof body.sessionId !== 'string' || body.sessionId.trim() === '' → 400 { error: "sessionId required" }
 *     - body.sessionId.length > 128 → 400 { error: "sessionId too long" }
 *   → SpecEntry (세션 연결)
 *
 * GET /specs
 *   → HTML (Web Dashboard)
 *
 * GET /specs/:id
 *   → HTML (Spec Detail View)
 */
export function createSpecRoutes(registry: SpecRegistry): RouteDefinition[];

/**
 * Path parameter 추출 유틸리티.
 * matchPath()는 boolean만 반환하므로 핸들러에서 URL을 직접 파싱.
 *
 * 사용 관례:
 *   GET /api/specs/:id       → new URL(req.url).pathname.split('/')[3]
 *   GET /api/specs/:id/content → new URL(req.url).pathname.split('/')[3]
 *   GET /specs/:id           → new URL(req.url).pathname.split('/')[2]
 *
 * 추출된 id를 registry.getSpec(id)에 전달.
 * 빈 문자열이면 404 반환.
 */
function extractSpecId(pathname: string, segmentIndex: number): string | null;

/**
 * POST CSRF 방어 — Content-Type 검증.
 * 'application/json'이 아니면 415 Response 반환. null이면 통과.
 * 모든 POST 핸들러 상단에서 호출:
 *   const err = requireJsonContentType(req); if (err) return err;
 */
function requireJsonContentType(req: Request): Response | null;
```

#### 3.2.6 Web Dashboard (`src/spec-tracker/dashboard.ts`)

> **LLM 유지보수성 원칙**: 단일 파일 내 component function 패턴.
> 거대한 HTML 문자열 하나가 아니라, 작은 순수 함수들로 분리하여
> LLM이 개별 컴포넌트만 수정해도 다른 부분에 영향 없도록 한다.
>
> oh-my-opencode-dashboard, Augment Intent 참고:
> - CSS custom properties로 디자인 토큰 분리
> - 각 UI 섹션이 독립 함수 → LLM diff 최소화
> - 클라이언트 JS는 polling + innerHTML 교체만 (상태 관리 없음)

```typescript
// ── Layer 1: Design Tokens ──
// CSS custom properties로 색상/간격/폰트 일괄 관리.
// 테마 변경 시 이 블록만 수정.
const TOKENS_CSS: string;
// 포함: --color-bg, --color-surface, --color-border,
//       --color-completed (#22c55e), --color-in-progress (#3b82f6),
//       --color-pending (#6b7280), --color-stale (#ef4444), --color-draft (#9ca3af)
//       --radius (8px), --gap (16px), --font-mono

// ── Layer 2: Component Functions ──
// 각 함수는 HTML string 반환. 독립적으로 수정 가능.
//
// ⚠️ XSS 방어 필수: 사용자 제어 문자열을 HTML에 보간하기 전 escapeHtml() 필수 적용.
// 대상: title, projectName, agent, task.title, dependencyAnalysis, sessionLog,
//       renderContentTabs의 spec/state 원문 (<pre> 블록도 예외 없음).
// escapeHtml 변환: & → &amp;  < → &lt;  > → &gt;  " → &quot;  ' → &#39;

/** HTML entity 이스케이프 — 모든 render* 함수에서 사용. export 하지 않음 (내부 유틸리티). */
function escapeHtml(str: string): string;

/** 상단 요약 카드 (활성/완료/전체 진행률) */
function renderSummaryCards(snapshot: SpecRegistrySnapshot): string;

/** 개별 스펙 카드 — 제목, 프로젝트명, progress bar, 상태 배지 */
function renderSpecCard(spec: SpecEntry): string;

/** progress bar — percent 기반, 상태별 색상 토큰 적용 */
function renderProgressBar(progress: { done: number; total: number; percent: number }): string;

/** task 테이블 — status icon (✓/◐/○), agent, timing 컬럼 */
function renderTaskTable(tasks: SpecTask[]): string;

/** 스펙/state 원문 탭 (상세 페이지) — <pre> 블록 */
function renderContentTabs(specContent: string | null, stateContent: string): string;

// ── Layer 3: Page Assembly ──

/** HTML 페이지 shell — title, css, body, js를 조립 */
function renderLayout(opts: { title: string; css: string; body: string; js: string }): string;

// ── Layer 4: Client JS ──
// polling만. 상태 관리 없음.
const POLL_JS: string;
// polling 전략 (XSS 방어):
//   대시보드: 10초마다 fetch('/api/specs') → JSON 수신
//     → renderSpecCard()와 동일한 escapeHtml 적용하여 HTML 재구성
//     → #spec-list innerHTML 교체
//   상세 페이지: 5초마다 fetch('/api/specs/:id') → JSON 수신
//     → task.title 등 문자열 필드 반드시 escapeHtml 적용 후 innerHTML 교체
//     → status enum, 숫자 값은 escapeHtml 불필요
// POLL_JS에 escapeHtml 함수 복사본을 inline으로 포함 (외부 의존 없음)

// ── Public Exports ──

/**
 * 스펙 목록 대시보드 HTML.
 * 구성: renderLayout(renderSummaryCards + renderSpecCard[] + 마지막 스캔 시각)
 */
export function renderDashboardHtml(snapshot: SpecRegistrySnapshot): string;

/**
 * 스펙 상세 페이지 HTML.
 * 구성: renderLayout(제목/배지/progress + renderTaskTable + renderContentTabs)
 */
export function renderSpecDetailHtml(entry: SpecEntry, specContent: string | null, stateContent: string): string;
```

#### 3.2.7 Discord Formatter (`src/spec-tracker/discord-formatter.ts`)

```typescript
import type { EmbedData } from '../discord/types.ts';

/** 스펙 목록 임베드 (Discord /specs 명령어 응답) */
export function formatSpecListEmbed(snapshot: SpecRegistrySnapshot): EmbedData;

/** 스펙 상세 임베드 */
export function formatSpecDetailEmbed(entry: SpecEntry): EmbedData;

/** 스펙 이벤트 메시지 (task 완료, 스펙 완료 등) */
export function formatSpecEventMessage(event: SpecEvent): string;

/** 스펙 이벤트 임베드 */
export function formatSpecEventEmbed(event: SpecEvent): EmbedData;
```

#### 3.2.8 Plugin (`src/spec-tracker/plugin.ts`)

```typescript
import type { PrayBotPlugin } from '../plugin/types.ts';

export interface SpecTrackerPluginConfig {
  /** 스캔 루트 디렉토리들 (기본: ['~/work', '~/worktrees']) */
  scanRoots?: string[];
  /** 제외 패턴 (기본: ['**/node_modules/**', '**/.git/**']) */
  excludePatterns?: string[];
  /** 리프레시 주기 ms (기본: 30000) */
  refreshIntervalMs?: number;
  /** stale 판정 시간 ms (기본: 86400000 = 24h) */
  staleThresholdMs?: number;
  /** Discord 채널 ID (스펙 이벤트 알림 전송 대상) */
  discordChannelId?: string | null;
  /** file watcher 활성화 (기본: true) */
  enableFileWatcher?: boolean;
}

/**
 * Spec Tracker Plugin.
 *
 * onStart:
 *   1. SpecRegistry 생성 + 초기 스캔
 *   2. HTTP routes 등록 (/api/specs/*, /specs/*)
 *   3. file watcher 시작 (enableFileWatcher=true)
 *   4. auto-refresh 시작
 *   5. Discord 이벤트 콜백 등록 (discordChannelId 설정 시)
 *
 * onStop:
 *   1. auto-refresh 중지
 *   2. file watcher 중지
 */
export function createSpecTrackerPlugin(config?: SpecTrackerPluginConfig): PrayBotPlugin;
```

### 3.3 Flow

#### 스펙 스캔 + 인덱싱 흐름

```
pray-bot start
  │
  ├─ SpecTrackerPlugin.onStart()
  │    ├─ SpecRegistry.refresh()
  │    │    ├─ scanForStateFiles(['~/work', '~/worktrees'])
  │    │    │    → roots의 ~ → os.homedir() 확장
  │    │    │    → Bun.Glob('**/*.state.md') → 파일 경로 목록
  │    │    │    → maxDepth 필터 + excludePatterns post-filter
  │    │    │
  │    │    ├─ 각 .state.md 파일에 대해:
  │    │    │    ├─ parseStateFile(content) → SpecState
  │    │    │    ├─ extractProjectInfo(path) → project/worktree 정보
  │    │    │    └─ SpecEntry 생성 (status, progress 계산)
  │    │    │
  │    │    └─ 이전 스냅샷과 diff → SpecEvent 발생
  │    │         ├─ 새 task completed → { type: 'task_completed', ... }
  │    │         ├─ 전체 완료 → { type: 'spec_completed', ... }
  │    │         └─ 24시간 미갱신 → { type: 'spec_stale', ... }
  │    │
  │    ├─ startAutoRefresh() → 30초마다 refresh()
  │    ├─ startFileWatcher() → FSWatcher on *.state.md
  │    └─ HTTP routes 등록
  │
  └─ pray-bot HTTP server ready
```

#### 웹 대시보드 흐름

```
브라우저 → GET /specs
  │
  ├─ renderDashboardHtml(registry.getSnapshot()) → HTML 응답
  │
  └─ 브라우저에서 10초마다:
       fetch('/api/specs') → JSON
       → escapeHtml 적용하여 HTML 재구성 → #spec-list innerHTML 교체

브라우저 → GET /specs/:id
  │
  ├─ registry.getSpec(id)
  ├─ Bun.file(specPath).text() → 스펙 원문
  ├─ Bun.file(statePath).text() → state 원문
  └─ renderSpecDetailHtml(entry, specContent, stateContent) → HTML 응답
       │
       └─ 브라우저에서 5초마다:
            fetch('/api/specs/:id') → JSON
            → task.title 등 문자열 escapeHtml 적용 후 #task-table, #progress innerHTML 교체
```

#### Discord 알림 흐름

```
SpecRegistry.onEvent 콜백
  │
  ├─ task_completed → Discord thread에 메시지 전송
  │    "✅ Task 3/8 완료: 'Hook HTTP 엔드포인트 구현'"
  │
  ├─ spec_completed → Discord channel에 임베드 전송
  │    "🎉 스펙 완료: 'Session Activity Phase' (8/8 tasks)"
  │
  ├─ spec_stale → Discord channel에 경고
  │    "⚠️ 스펙 'Web Session Monitor' 24시간 이상 미갱신"
  │
  └─ session_linked → Discord thread에 메시지
       "🔗 Claude 세션 abc-123이 이 스펙에 연결되었습니다"
```

#### 세션 ↔ 스펙 연결 흐름

```
방법 1: Hook 기반 자동 감지 (session-activity-phase 스펙 구현 후)

  SessionStart hook → pray-bot POST /api/hook
    ├─ cwd에서 .state.md 검색
    │    grep 'in_progress' *.state.md
    └─ 매칭되면 registry.linkSession(specId, sessionId)

방법 2: HTTP API 수동 연결

  POST /api/specs/:id/link-session
  Body: { "sessionId": "abc-123" }
    → registry.linkSession(specId, sessionId)

방법 3: Claude Code 스킬에서 자동 (/sisyphus 실행 시)

  /sisyphus 시작
    → .state.md 읽기
    → curl POST pray-bot/api/specs/:id/link-session
```

#### File Watcher 흐름

```
state.md 파일 변경/삭제 감지 (Bun FSWatcher)
  │
  ├─ [변경 이벤트] parseStateFilePath(changedPath) → SpecState | null
  │    ├─ SpecState 반환 → SpecEntry 업데이트
  │    │    이전 entry와 diff
  │    │    diff 있으면 SpecEvent 발생
  │    │      ├─ task status 변경 → task_completed / spec_completed
  │    │      └─ onEvent 콜백 호출 → Discord 알림
  │    └─ null 반환 (파일 없음) → 삭제 이벤트와 동일 처리
  │
  └─ [삭제/rename 이벤트]
       → registry에서 해당 SpecEntry 제거
       → refresh() 완료 시 스캔 결과에 없는 모든 entry 일괄 제거
```

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/index.ts` | `spec-tracker` re-export 추가 | Low — export 1줄 |
| `src/bot.ts` | 없음 — plugin 시스템으로 연결 | None |
| `src/auto-thread/resolver.ts` | `extractOriginalProjectFromWorktree` import 재사용 | None — 이미 export됨 |
| `src/discord/types.ts` | 없음 — `EmbedData` import만 | None |
| `src/plugin/types.ts` | 없음 — `PrayBotPlugin` interface 재사용 | None |

**건드리지 않는 파일:**
- `src/usage-monitor/` — 기존 모니터링 로직 변경 없음
- `src/auto-thread/` — 기존 auto-thread 로직 변경 없음
- `src/cron/` — 기존 cron 로직 변경 없음
- `~/.claude/skills/spec/` — 기존 스킬 파일 변경 없음
- `~/.claude/skills/lite-spec/` — 기존 스킬 파일 변경 없음

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| module | `spec-tracker` | `src/spec-tracker/` — 스펙 추적 모듈 디렉토리명 |
| type | `SpecTask` | `.state.md` 테이블의 개별 task |
| type | `SpecState` | `.state.md` 파일 전체 파싱 결과 |
| type | `SpecEntry` | Registry가 관리하는 스펙 단위 (state + 메타데이터) |
| type | `SpecRegistrySnapshot` | 전체 스펙 스냅샷 |
| type | `SpecEvent` | Discord 알림용 이벤트 union |
| type | `ScanConfig` | 스캐너 설정 |
| type | `SpecRegistryConfig` | Registry 설정 |
| type | `SpecTrackerPluginConfig` | 플러그인 설정 |
| class | `SpecRegistry` | 스펙 상태 관리 핵심 클래스 |
| function | `parseStateFile` | `.state.md` content → `SpecState` |
| function | `parseStateFilePath` | 파일 경로 → `SpecState \| null` |
| function | `scanForStateFiles` | 디렉토리 스캔 → state.md 경로 목록 |
| function | `extractProjectInfo` | state.md 경로 → 프로젝트 정보 |
| function | `createSpecRoutes` | HTTP route factory |
| function | `renderDashboardHtml` | 대시보드 HTML 생성 |
| function | `renderSpecDetailHtml` | 상세 페이지 HTML 생성 |
| function | `renderSummaryCards` | 요약 카드 컴포넌트 |
| function | `renderSpecCard` | 스펙 카드 컴포넌트 |
| function | `renderProgressBar` | 진행률 바 컴포넌트 |
| function | `renderTaskTable` | task 테이블 컴포넌트 |
| function | `renderContentTabs` | 원문 탭 컴포넌트 |
| function | `renderLayout` | HTML 페이지 shell |
| function | `formatSpecListEmbed` | Discord 스펙 목록 임베드 |
| function | `formatSpecDetailEmbed` | Discord 스펙 상세 임베드 |
| function | `formatSpecEventMessage` | Discord 이벤트 텍스트 |
| function | `formatSpecEventEmbed` | Discord 이벤트 임베드 |
| function | `createSpecTrackerPlugin` | 플러그인 factory |
| function | `escapeHtml` | HTML entity 이스케이프 — dashboard.ts 내부 유틸리티 |
| constant | `TOKENS_CSS` | CSS custom properties 디자인 토큰 |
| constant | `POLL_JS` | 클라이언트 polling 스크립트 |
| dom-id | `#spec-list` | 대시보드 스펙 카드 리스트 컨테이너 |
| dom-id | `#task-table` | 상세 페이지 task 테이블 컨테이너 |
| dom-id | `#progress` | 상세 페이지 진행률 바 컨테이너 |
| dom-id | `#summary-cards` | 대시보드 요약 카드 컨테이너 |
| dom-id | `#last-scan` | 마지막 스캔 시각 표시 |
| endpoint | `GET /api/specs` | 스펙 목록 JSON |
| endpoint | `GET /api/specs/:id` | 스펙 상세 JSON |
| endpoint | `GET /api/specs/:id/content` | 스펙/state 원문 |
| endpoint | `POST /api/specs/refresh` | 강제 리프레시 |
| endpoint | `POST /api/specs/:id/link-session` | 세션 연결 |
| endpoint | `GET /specs` | 웹 대시보드 HTML |
| endpoint | `GET /specs/:id` | 스펙 상세 HTML |

### 3.6 Security Considerations

#### XSS 방어

| 대상 | 위치 | 처리 |
|------|------|------|
| `title`, `projectName`, `agent`, `task.title` | `renderSpecCard`, `renderTaskTable` | `escapeHtml()` 필수 |
| `dependencyAnalysis`, `sessionLog` | `renderSpecCard`, detail 페이지 | `escapeHtml()` 필수 |
| spec/state 원문 | `renderContentTabs` `<pre>` 블록 | `escapeHtml()` 필수 (`<pre>`는 entity 이스케이프 안 함) |
| POLL_JS client-side 렌더링 | JSON → innerHTML | inline `escapeHtml()` 복사본 사용 |

#### Path Traversal 방어 (`/api/specs/:id/content`)

`specPath`는 `.state.md` 파일 내 `> spec:` 필드에서 파싱되는 사용자 제어 값이므로 검증 필수.

```
검증 알고리즘:
1. resolved = path.resolve(path.dirname(statePath), rawSpecPath)
2. canonical = fs.realpathSync(resolved)          // symlink 해소
   → ENOENT 시 HTTP 404 { error: "spec file not found" }
3. roots    = scanRoots.map(r => fs.realpathSync(r))
4. valid    = roots.some(r => canonical.startsWith(r + path.sep))
5. if (!valid) → HTTP 403, body: { error: "path outside scan boundary" }

주의: string prefix 비교만으로는 symlink escape 가능 → realpathSync 필수
```

#### Symlink Escape 방어 (Scanner)

```
스캔 시:
1. roots = config.roots.map(r => fs.realpathSync(expandHome(r)))
2. glob 결과 → 각 경로를 fs.realpathSync() 시도
   실패(dangling symlink 등) → skip
3. canonical 경로가 roots 중 하나의 prefix로 시작하지 않으면 제외 + 로그 경고
```

#### 네트워크 바인딩

`PrayBot`은 기본 `0.0.0.0`에 바인딩된다. spec-tracker는 로컬 파일 내용을 서빙하므로:

- 로컬 전용 운영 시 `127.0.0.1` 바인딩 또는 방화벽 설정 권고
- `PrayBotConfig.authToken` 설정 시 모든 `/api/specs/*` 엔드포인트에 Bearer 토큰 검증 적용
  (metadata도 프로젝트 경로·세션 ID 포함으로 민감 정보에 해당)
- §2 Non-Goals "로컬 전용"은 의도이지 기술적 강제가 아님 — 사용자가 인지해야 함

#### CSRF 방어

`POST /api/specs/refresh`, `POST /api/specs/:id/link-session`은 상태 변경 엔드포인트이므로 CSRF 방어 필수.

- 모든 POST 핸들러 상단에서 `Content-Type: application/json` 헤더 검증
  - 불일치 시 415 `{ error: "Content-Type must be application/json" }`
  - 브라우저의 cross-origin simple request는 `application/json`을 전송 불가 →
    CORS preflight가 트리거되어 차단 (별도 CORS 설정 없이 effective)
- 구현: `requireJsonContentType(req)` 유틸리티 함수 (§3.2.5 참조)

## 4. Verification Criteria

### Parser

- [ ] Given: sisyphus가 생성한 표준 .state.md 파일 / When: `parseStateFile(content)` / Then: 모든 task의 status, agent, timing이 정확히 파싱됨
- [ ] Given: 비표준 또는 빈 .state.md / When: `parseStateFile(content)` / Then: 에러 없이 빈 tasks 반환
- [ ] Given: task 테이블에 `completed`, `in_progress`, `pending`, `blocked` 혼재 / When: 파싱 / Then: 각 status 정확히 매칭
- [ ] Given: Agent 값이 "—" / When: 파싱 / Then: `agent === null`
- [ ] Given: `## Backlog Queue` 섹션 포함된 .state.md / When: 파싱 / Then: 에러 없이 무시, Tasks 정상 파싱

### Scanner

- [ ] Given: `~/work/js/pray-bot/docs/foo.state.md` 존재 / When: `scanForStateFiles({ roots: ['~/work'] })` / Then: 경로 목록에 포함 (~ → homedir 확장됨)
- [ ] Given: `node_modules/` 하위에 .state.md 존재 / When: 스캔 / Then: excludePatterns에 의해 제외
- [ ] Given: worktree 경로 `~/worktrees/feat/gate/docs/bar.state.md` / When: `extractProjectInfo()` / Then: `worktree.name === 'feat'`
- [ ] Given: maxDepth=3, root/a/b/c/d/foo.state.md (depth 4) / When: 스캔 / Then: 제외됨

### Registry

- [ ] Given: 3개 .state.md 존재 (1 completed, 1 in_progress, 1 draft) / When: `refresh()` / Then: `snapshot.activeCount === 1`, `completedCount === 1`
- [ ] Given: state.md에서 task 1개가 pending → completed 변경 / When: file watcher 감지 / Then: `onEvent({ type: 'task_completed', ... })` 호출
- [ ] Given: 모든 task completed / When: refresh / Then: `status === 'completed'` + `onEvent({ type: 'spec_completed' })`
- [ ] Given: state.md mtime이 24시간 이상 전 / When: refresh / Then: `status === 'stale'` + `onEvent({ type: 'spec_stale' })`
- [ ] Given: `linkSession(specId, sessionId)` 호출 / When: `getSpec(specId)` / Then: `linkedSessionId === sessionId`

### HTTP API

- [ ] Given: pray-bot 실행 중 / When: `GET /api/specs` / Then: JSON 응답, `Content-Type: application/json`
- [ ] Given: 스펙 존재 / When: `GET /api/specs/:id` / Then: SpecEntry JSON
- [ ] Given: 스펙 없음 / When: `GET /api/specs/nonexistent` / Then: 404
- [ ] Given: `GET /api/specs?status=in_progress` / When: 2개 중 1개만 in_progress / Then: 1개만 반환
- [ ] Given: `POST /api/specs/refresh` / When: 새 .state.md 추가됨 / Then: 응답에 새 스펙 포함

### Web Dashboard

- [ ] Given: pray-bot 실행 중 / When: `GET /specs` / Then: HTML 응답, `Content-Type: text/html`
- [ ] Given: 3개 스펙 / When: 대시보드 렌더링 / Then: 3개 카드 표시, 각각 progress bar 포함
- [ ] Given: 스펙 카드 클릭 / When: `/specs/:id` 이동 / Then: 상세 페이지에 task 테이블 표시

### Discord

- [ ] Given: task_completed 이벤트 / When: `formatSpecEventMessage()` / Then: "✅ Task N/M 완료" 형식
- [ ] Given: spec_completed 이벤트 / When: `formatSpecEventEmbed()` / Then: 녹색 임베드, 전체 task 요약
- [ ] Given: 스펙 목록 요청 / When: `formatSpecListEmbed()` / Then: 각 스펙이 progress bar + status 포함

### Security

- [ ] Given: `renderSpecCard()`에 `<script>alert(1)</script>` 포함된 title / When: HTML 렌더링 / Then: `&lt;script&gt;alert(1)&lt;/script&gt;`로 이스케이프되어 출력
- [ ] Given: `renderContentTabs()`에 `<img src=x onerror=alert(1)>` 포함된 spec 원문 / When: HTML 렌더링 / Then: `<pre>` 내에서 이스케이프됨
- [ ] Given: `GET /api/specs/:id/content`에 specPath `../../../../etc/passwd` / When: 요청 / Then: 403 응답, body `{ error: "path outside scan boundary" }`
- [ ] Given: scanRoot 하위에 외부 디렉토리를 가리키는 symlink가 포함된 .state.md 경로 / When: scanner 실행 / Then: 해당 경로 제외 + 경고 로그 출력
- [ ] Given: `POST /api/specs/:id/link-session` with `Content-Type: text/plain` / When: 요청 / Then: 415 응답
- [ ] Given: `POST /api/specs/:id/link-session` with body `{ "sessionId": "" }` / When: 요청 / Then: 400 응답 `{ error: "sessionId required" }`
- [ ] Given: `GET /api/specs/:id/content` with specPath pointing to deleted file / When: 요청 / Then: 404 응답

### Integration

- [ ] `npx tsc --noEmit` 통과
- [ ] `bun test` 통과 (기존 테스트 포함)
- [ ] `GET /health` 기존 응답 유지 (regression 없음)

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| 많은 .state.md 파일 스캔 시 느려짐 | 초기 로딩 지연 | `maxDepth: 5` 제한 + excludePatterns으로 node_modules 등 제외. 초기 스캔 async, 이후 file watcher로 점진적 업데이트 |
| .state.md 포맷이 스킬 업데이트로 변경됨 | 파서 깨짐 | 파서를 방어적으로 작성 (파싱 실패 시 빈 tasks 반환, 에러 로그만). `.state.md` 포맷 변경 시 파서만 업데이트 |
| File watcher가 많은 디렉토리 감시 시 리소스 소모 | 메모리/FD 증가 | 스캔된 .state.md 파일만 감시 (디렉토리 전체가 아님). 최대 50개 제한 |
| Dashboard HTML이 커져서 관리 어려움 | 개발 생산성 저하 | Component function 패턴으로 개별 함수 수정 가능. 복잡해지면 향후 별도 SPA로 분리 (이 스펙 범위 밖) |
| 세션-스펙 자동 연결이 부정확 | 잘못된 매칭 | 자동 감지는 보조 수단, 수동 API가 primary. cwd + in_progress state.md 매칭으로 false positive 최소화 |
| `0.0.0.0` 바인딩으로 파일 내용 네트워크 노출 | 스펙/state 파일이 같은 네트워크 사용자에게 노출 | 로컬 전용 운영 시 `127.0.0.1` 바인딩 권고. `PrayBotConfig.authToken` 설정 시 `/api/specs/:id/content`에 Bearer 인증 적용 |
| watcher + auto-refresh 동시 실행으로 Discord 중복 알림 | 사용자 알림 노이즈 | `_refreshing` flag + 500ms debounce + 30초 TTL 이벤트 서명 Set으로 중복 suppression (§3.2.4 동시성 계약) |

<!-- ═══════════════════════════════════════════ -->
<!-- Iterative — Updated each loop              -->
<!-- ═══════════════════════════════════════════ -->

## 6. Task Checklist

> Mark `[x]` only after verify passes.

### Phase 1: Core (Parser + Scanner + Registry)

- [ ] ✅ Step 1: `src/spec-tracker/types.ts` — 모든 타입 정의 → verify: `npx tsc --noEmit`
- [ ] ✅ Step 2: `src/spec-tracker/parser.ts` — `.state.md` 파서 구현 (방어적 파싱, `## Backlog Queue` 무시) → verify: unit test — 표준/비표준/빈 파일 파싱
- [ ] ✅ Step 3: `src/spec-tracker/scanner.ts` — 파일시스템 스캔 (`~` → `homedir()` 확장, maxDepth post-filter) → verify: unit test — 경로 추출, excludePatterns 적용, depth 필터
- [ ] ✅ Step 4: `src/spec-tracker/registry.ts` — SpecRegistry 구현 (refresh, getSnapshot, linkSession, onEvent) → verify: unit test — 진행률 계산, 이벤트 발생, stale 감지
- [ ] ✅ Step 5: `src/spec-tracker/__tests__/parser.test.ts` + `scanner.test.ts` + `registry.test.ts` → verify: `bun test`

### Phase 2: HTTP API + Web Dashboard

- [ ] ✅ Step 6: `src/spec-tracker/routes.ts` — REST API 엔드포인트 (handler-level, mock registry 주입 가능) → verify: unit test — handler에 mock registry 주입, 각 엔드포인트 응답 확인
- [ ] ✅ Step 7: `src/spec-tracker/dashboard.ts` — component function 패턴 (TOKENS_CSS + render* 함수들 + POLL_JS + renderLayout) → verify: GET /specs 응답이 유효한 HTML, progress bar 포함
- [ ] ✅ Step 8: `src/spec-tracker/__tests__/routes.test.ts` + `dashboard.test.ts` → verify: `bun test`

### Phase 3: Discord + Plugin

- [ ] ✅ Step 9: `src/spec-tracker/discord-formatter.ts` — Discord 임베드/메시지 포맷터 → verify: unit test — 각 이벤트 타입별 포맷 확인
- [ ] ✅ Step 10: `src/spec-tracker/plugin.ts` — PrayBotPlugin 구현 (onStart/onStop lifecycle) → verify: plugin 등록 후 `/api/specs` + `/specs` 엔드포인트 동작
- [ ] ✅ Step 11: `src/spec-tracker/index.ts` + `src/index.ts` re-export → verify: `npx tsc --noEmit`

### Phase 4: Integration

- [ ] ⚠️ Step 12: File watcher 통합 테스트 — state.md 수정 시 registry 업데이트 + 이벤트 발생 확인 → verify: 실제 파일 수정 후 `GET /api/specs` 반영 확인
- [ ] ⚠️ Step 13: 실제 스펙 데이터 통합 테스트 — `docs/session-activity-phase.state.md` 파싱 확인 → verify: 기존 state.md가 정확히 파싱되어 대시보드에 표시
- [ ] ⚠️ Step 14: Web dashboard 브라우저 테스트 — `http://localhost:4488/specs` 접속 → verify: 스펙 카드 리스트 + 클릭 → 상세 페이지 동작

## 7. Open Questions

(해결된 항목은 §8 Decision Log로 이동 완료)

<!-- ═══════════════════════════════════════════ -->
<!-- Cumulative — Append-only, never delete     -->
<!-- ═══════════════════════════════════════════ -->

## 8. Decision Log

- 2026-02-18: 읽기 전용 대시보드로 결정. 스펙 편집은 Claude Code 세션에서만 수행 — 웹 UI에서 수정하면 충돌 위험.
- 2026-02-18: 외부 의존성 없는 vanilla HTML로 결정. pray-bot은 Bun-first, 의존성 최소화 원칙.
- 2026-02-18: .state.md 포맷 파서를 방어적으로 설계. 스킬이 포맷을 변경해도 파서가 깨지지 않도록.
- 2026-02-18: Plugin 패턴으로 구현. pray-bot의 기존 plugin 시스템(`PrayBotPlugin` interface)을 활용하여 core에 침투하지 않음.
- 2026-02-18: Augment Intent의 "living spec" 개념 참고 — spec이 agent 작업 후 자동 업데이트되는 것은 이미 /sisyphus `.state.md`가 동일한 역할. 우리는 그 위에 가시성(dashboard + Discord)만 추가.
- 2026-02-18: GitHub spec-kit의 phase gate 방식 참고 — specify → plan → tasks → implement 단계는 /spec 스킬의 §0-§10 구조가 이미 동등한 역할.
- 2026-02-18: file watcher는 state.md 파일만 감시 (디렉토리 전체가 아님). Bun의 `fs.watch()` 사용, 최대 50개 제한.
- 2026-02-18 rev2: Dashboard를 "vanilla HTML vs Tailwind CDN" → **vanilla HTML 확정**. CDN 의존성 불필요, 로컬 전용.
- 2026-02-18 rev2: 스펙 markdown 렌더링 → **`<pre>` 원문 표시 확정**. markdown→HTML 변환은 별도 의존성 필요하므로 범위 밖.
- 2026-02-18 rev2: scan roots 기본값 → **`~/work` + `~/worktrees`** 확정. config로 받되 기본값 이 2개.
- 2026-02-18 rev2: 실시간 업데이트 → **polling 확정** (SSE 불필요). 로컬 전용이므로 10초/5초 polling이면 충분.
- 2026-02-18 rev2: Dashboard HTML → **component function 패턴** 확정. oh-my-opencode-dashboard, Augment Intent 참고. 단일 파일 내 TOKENS_CSS + render* 함수 + POLL_JS + renderLayout 구조. LLM이 개별 함수만 수정 가능.
- 2026-02-18 rev2: Scanner `~` 확장 → `os.homedir()` 사용. Bun.Glob은 `~` 미지원. maxDepth는 glob 결과 post-filter.
- 2026-02-18 rev2: DOM contract — 안정적 ID(`#spec-list`, `#task-table`, `#progress`, `#summary-cards`, `#last-scan`)를 §3.5에 명시. client JS는 이 ID만 참조.
- 2026-02-18 rev2: .state.md `> status:` 메타데이터, `## Backlog Queue` 섹션 → 파싱 범위 밖 (§2 Non-Goals). 현재 작업 중인 state만 관심.
- 2026-02-18 rev2: Route 테스트 → handler-level 단위 테스트 (mock registry 주입). 서버 기동 테스트는 Step 14 통합 테스트에서.
- 2026-02-18 rev3: XSS 방어 → `escapeHtml()` 함수를 `dashboard.ts`에 필수 포함. 모든 render* 함수와 POLL_JS에서 사용자 제어 문자열에 적용. `<pre>` 블록도 예외 없음.
- 2026-02-18 rev3: Path traversal 방어 → `/api/specs/:id/content`에서 `fs.realpathSync()` + scanRoots prefix check 필수. 문자열 비교만으로는 symlink escape 가능.
- 2026-02-18 rev3: Scanner symlink 방어 → scan roots와 glob 결과 모두 `realpathSync()`로 canonical화. symlink가 scanRoot 외부를 가리켜도 인덱싱 방지.
- 2026-02-18 rev3: Registry 동시성 계약 → watcher 500ms debounce + `_refreshing` flag 직렬화 + 30초 TTL 이벤트 중복 suppression. Discord 중복 알림 방지.
- 2026-02-18 rev3: SpecEntry id → 절대 경로 기반 base64url(24자). 두 scan root에 동일 상대 경로 존재 시 충돌 방지.
- 2026-02-18 rev3: 네트워크 바인딩 위험 → §5 Risks + §3.6에 명시. spec-tracker는 파일 내용 서빙하므로 `127.0.0.1` 바인딩 권고.
- 2026-02-18 rev4: SpecEntry id → SHA-256 hash 방식으로 변경. base64url slice는 공통 prefix 충돌 보장이므로 사용 금지.
- 2026-02-18 rev4: _concurrencyNote: never 제거. JSDoc 주석이 충분하며 never 타입 필드는 strict 모드 컴파일 오류.
- 2026-02-18 rev4: 이벤트 dedup → Map<string, number> + lazy GC (이벤트 처리마다 만료 항목 삭제) 명시.
- 2026-02-18 rev4: path param 추출 → extractSpecId() + requireJsonContentType() 유틸리티 §3.2.5에 추가.
- 2026-02-18 rev4: POST CSRF 방어 → Content-Type: application/json 검증 필수. §3.6 CSRF 방어 섹션 신설.
- 2026-02-18 rev4: authToken 적용 범위 → /content만이 아닌 모든 /api/specs/* 엔드포인트로 확장.
- 2026-02-18 rev4: sessionId 입력 검증 → §3.2.5 POST 엔드포인트에 validation 규칙 명시.
- 2026-02-18 rev4: realpathSync ENOENT 처리 → §3.6 + §3.2.5에 404 반환 명시.
- 2026-02-18 rev4: File watcher 삭제 처리 → §3.3에 rename/unlink 이벤트 흐름 추가. refresh() 완료 시 소멸된 entry 일괄 제거.

## 9. Handoff Snapshot

(초기 draft — 작업 시작 전)

## 10. Changelog

| rev | date | summary |
|-----|------|---------|
| 1 | 2026-02-18 | Initial draft. Parser + Scanner + Registry + HTTP API + Web Dashboard + Discord 연동 설계. 외부 도구(Augment Intent, spec-kit, Kiro) 참고. |
| 2 | 2026-02-18 | Review 반영: §3.2.6 dashboard를 component function 패턴으로 재설계 (TOKENS_CSS + render* + POLL_JS + renderLayout). §3.2.3 Scanner에 `~` → `homedir()` 확장 + maxDepth post-filter 구현 디테일 추가. §3.5에 DOM ID contract + dashboard 내부 함수명 추가. §7 해결된 질문 4개를 §8로 이동 (vanilla HTML, `<pre>` 원문, scan roots, polling 확정). §2 Non-Goals에 `> status:` 파싱, Backlog Queue 파싱 제외 추가. §4에 Backlog Queue 무시 테스트, maxDepth 필터 테스트, Agent "—" → null 테스트 추가. §6 Step 2,3,6,7 verify 디테일 보강. |
| 3 | 2026-02-18 | spec-review 반영: §3.6 Security Considerations 신설 (XSS/path traversal/symlink/네트워크 바인딩). §3.2.1 id 생성 알고리즘 명시 (base64url, 절대경로 기반). §3.2.3 realpathSync() + canonical boundary check 추가. §3.2.4 동시성 계약 추가 (debounce/직렬화/이벤트 중복 suppression). §3.2.5 path validation pseudo-code 명시. §3.2.6 escapeHtml() 필수화 + POLL_JS XSS 방어 전략 명시. §3.5 escapeHtml 항목 추가. §4 Security 검증 기준 4건 추가. §5 네트워크 바인딩·동시성 위험 항목 추가. |
| 4 | 2026-02-18 | spec-review 2차 반영: §3.2.1 id → SHA-256 hash (base64url slice 충돌 버그 수정). §3.2.4 _concurrencyNote:never 제거 + 이벤트 dedup Map lazy GC 명시. §3.2.5 extractSpecId()/requireJsonContentType() 유틸리티 추가 + POST sessionId validation + ENOENT 404 처리. §3.3 File Watcher에 삭제/rename 이벤트 흐름 추가. §3.6 CSRF 방어 섹션 신설 + authToken 전체 /api/specs/* 적용 + ENOENT 404 명시. §4 Security에 CSRF/sessionId/ENOENT 검증 기준 3건 추가. |
