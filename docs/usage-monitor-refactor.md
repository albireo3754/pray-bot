# Usage Monitor Refactor

> status: draft
> created: 2026-02-17
> updated: 2026-02-17
> revision: 4

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** 아래는 이 스펙의 섹션 매핑.

| Item | Section |
|------|---------|
| Task Checklist | §6 |
| Naming Conventions | §3.5 |
| State file | `docs/usage-monitor-refactor.state.md` |
| Decision Log | §8 (append-only) |
| Handoff Snapshot | §9 |
| Changelog | §10 |

<!-- ═══════════════════════════════════════════ -->
<!-- Fixed — Modify only on direction change    -->
<!-- ═══════════════════════════════════════════ -->

## 1. Goal

`monitor/`(ClaudeSessionMonitor)와 `codex-monitor/`(CodexSessionMonitor)를 `usage-monitor/` 하나로 합치고, 클래스명도 `ClaudeUsageMonitor`/`CodexUsageMonitor`로 통일하며, 통합 `UsageMonitor` 클래스를 추가하여:

1. 프로바이더별 모니터를 단일 디렉토리(`usage-monitor/`)에서 관리
2. `UsageMonitor`가 여러 프로바이더의 세션을 머지해서 단일 API로 제공
3. `auto-thread`가 `AutoThreadMonitorGroup` 대신 `UsageMonitor` 하나만 받도록 단순화
4. 기존 `monitor/` re-export와 `codex-monitor/` re-export를 `usage-monitor/`로 교체

## 2. Non-Goals

- auto-thread 로직 자체의 변경 (세션 감지, 스레드 생성, 모니터 로그 등)
- codex-server/ (JSON-RPC 클라이언트) — 모니터링과 무관한 제어 평면이므로 대상 아님
- formatter, token-usage 로직의 재작성 — 파일 이동만, 로직 변경 없음
- 테스트 로직 변경 — import 경로만 업데이트

## 3. Design

### 3.1 Deliverables

| Deliverable | Path | Consumer | Format |
|-------------|------|----------|--------|
| UsageMonitor 통합 클래스 | `src/usage-monitor/index.ts` | auto-thread, bot plugins, HTTP routes | Class |
| Claude provider | `src/usage-monitor/claude-monitor.ts` | UsageMonitor | Class (ClaudeSessionMonitor → ClaudeUsageMonitor rename + 이동) |
| Codex provider | `src/usage-monitor/codex-monitor.ts` | UsageMonitor | Class (CodexSessionMonitor → CodexUsageMonitor rename + 이동) |
| 공유 타입 | `src/usage-monitor/types.ts` | 전체 | Types (기존 monitor/types.ts 이동) |
| Claude discovery | `src/usage-monitor/claude-discovery.ts` | claude-monitor | Functions (기존 monitor/discovery.ts 이동) |
| Claude parser | `src/usage-monitor/claude-parser.ts` | claude-monitor | Functions (기존 monitor/parser.ts 이동) |
| Activity phase | `src/usage-monitor/activity-phase.ts` | claude-monitor | Function (기존 monitor/activity-phase.ts 이동) |
| Formatter | `src/usage-monitor/formatter.ts` | Discord commands | Functions (기존 monitor/formatter.ts 이동) |
| Token usage formatter | `src/usage-monitor/token-usage.ts` | Discord commands | Functions — `formatTokenUsageText/Embed` 유지, `measureTokenUsage()` 제거 (→ `SessionMonitorProvider.getTokenUsageReport()`로 이동) |
| 테스트 | `src/usage-monitor/__tests__/` | CI | Tests (이동 + import 수정) |

### 3.2 Interface

```ts
// === src/usage-monitor/types.ts ===
// 기존 monitor/types.ts 그대로. 변경 없음.
export type ActivityPhase = 'busy' | 'interactable' | 'waiting_permission' | 'waiting_question';

export interface SessionSnapshot {
  provider?: 'claude' | 'codex';
  sessionId: string;
  // ... (기존 필드 전부 유지)
}

export interface MonitorStatus {
  sessions: SessionSnapshot[];
  activeCount: number;
  totalCount: number;
  lastRefresh: Date;
}

export interface TokenUsageSession {
  sessionId: string;
  projectName: string;
  slug: string;
  state: SessionSnapshot['state'];
  model: string | null;
  tokens: { input: number; output: number; cached: number };
  estimatedCostUsd: number;
  lastActivity: Date;
  lastUserMessage: string | null;
  currentTools: string[];
}

export interface TokenUsageReport {
  timestamp: Date;
  sessions: TokenUsageSession[];
  totals: { input: number; output: number; cached: number; estimatedCostUsd: number };
  activeCount: number;
  totalCount: number;
}

// === src/usage-monitor/index.ts ===

/** 프로바이더가 구현해야 하는 최소 인터페이스 */
export interface SessionMonitorProvider {
  init(): Promise<void>;
  stop(): void;
  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void;
  getAll(): SessionSnapshot[];
  getActive(): SessionSnapshot[];
  getSession(query: string): SessionSnapshot | null;
  getStatus(): MonitorStatus;
  /** 프로바이더별 토큰 사용량 리포트 (자체 pricing 모델 적용) */
  getTokenUsageReport(): TokenUsageReport;
}

const STATE_ORDER: Record<SessionSnapshot['state'], number> = {
  active: 0, idle: 1, completed: 2, stale: 3,
};

export class UsageMonitor implements SessionMonitorProvider {
  private providers = new Map<string, SessionMonitorProvider>();
  /** provider별 최신 세션 캐시 */
  private sessionsByProvider = new Map<string, SessionSnapshot[]>();
  private onRefreshCallbacks: Array<(sessions: SessionSnapshot[]) => Promise<void>> = [];
  private lastRefresh = new Date();

  /** 프로바이더 등록 (init 전에 호출) */
  addProvider(name: string, provider: SessionMonitorProvider): void {
    this.providers.set(name, provider);
  }

  /** 모든 프로바이더 init + onRefresh 바인딩 */
  async init(): Promise<void> {
    for (const [name, provider] of this.providers) {
      provider.onRefresh(async (sessions) => {
        this.sessionsByProvider.set(name, sessions);
        await this.emitMerged();
      });
      await provider.init();
    }
  }

  stop(): void {
    for (const provider of this.providers.values()) {
      provider.stop();
    }
  }

  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void {
    this.onRefreshCallbacks.push(cb);
  }

  /** 머지 로직: provider:sessionId 기준 dedup, state 우선 → lastActivity 최신 순 */
  private mergeSessions(): SessionSnapshot[] {
    const merged = new Map<string, SessionSnapshot>();
    for (const sessions of this.sessionsByProvider.values()) {
      for (const s of sessions) {
        const key = `${s.provider ?? 'claude'}:${s.sessionId}`;
        const existing = merged.get(key);
        if (!existing || s.lastActivity.getTime() > existing.lastActivity.getTime()) {
          merged.set(key, s);
        }
      }
    }
    return Array.from(merged.values())
      .filter((s) => s.state !== 'stale')
      .sort((a, b) => {
        const sd = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        if (sd !== 0) return sd;
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      });
  }

  private async emitMerged(): Promise<void> {
    this.lastRefresh = new Date();
    const sessions = this.mergeSessions();
    for (const cb of this.onRefreshCallbacks) {
      await cb(sessions).catch(console.error);
    }
  }

  getAll(): SessionSnapshot[] { return this.mergeSessions(); }
  getActive(): SessionSnapshot[] { return this.getAll().filter((s) => s.state === 'active' || s.state === 'idle'); }
  getSession(query: string): SessionSnapshot | null {
    const q = query.toLowerCase();
    for (const s of this.getAll()) {
      if (s.sessionId === query) return s;
      if (s.slug.toLowerCase().includes(q)) return s;
      if (s.sessionId.toLowerCase().startsWith(q)) return s;
      if (s.projectName.toLowerCase().includes(q)) return s;
    }
    return null;
  }
  getStatus(): MonitorStatus {
    const sessions = this.getAll();
    return { sessions, activeCount: sessions.filter((s) => s.state === 'active').length, totalCount: sessions.length, lastRefresh: this.lastRefresh };
  }

  /** 모든 프로바이더의 토큰 리포트를 머지 */
  getTokenUsageReport(): TokenUsageReport {
    const allSessions: TokenUsageSession[] = [];
    for (const provider of this.providers.values()) {
      const report = provider.getTokenUsageReport();
      allSessions.push(...report.sessions);
    }
    const totals = { input: 0, output: 0, cached: 0, estimatedCostUsd: 0 };
    for (const s of allSessions) {
      totals.input += s.tokens.input;
      totals.output += s.tokens.output;
      totals.cached += s.tokens.cached;
      totals.estimatedCostUsd += s.estimatedCostUsd;
    }
    return {
      timestamp: new Date(),
      sessions: allSessions.sort((a, b) => {
        const sd = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        return sd !== 0 ? sd : b.lastActivity.getTime() - a.lastActivity.getTime();
      }),
      totals,
      activeCount: allSessions.filter((s) => s.state === 'active').length,
      totalCount: allSessions.length,
    };
  }
}
```

### 3.2.1 auto-thread 변경 (before/after)

```ts
// === BEFORE: auto-thread/index.ts ===

type AutoThreadSessionMonitor = {
  onRefresh: (cb: (sessions: SessionSnapshot[]) => Promise<void>) => void;
};
type AutoThreadMonitorGroup = {
  claude?: AutoThreadSessionMonitor;
  codex?: AutoThreadSessionMonitor;
};
type AutoThreadMonitorInput = AutoThreadSessionMonitor | AutoThreadMonitorGroup;

export class AutoThreadDiscovery {
  constructor(
    private config: AutoThreadConfig,
    private monitor: AutoThreadMonitorInput,       // ← 두 가지 형태
    private channelRegistry: ChannelRegistry,
    private discordClient: DiscordClient,
    private getThreadRoutes: () => Map<string, DiscordThreadRoute>,
  ) {}

  private bindMonitors(): void {
    if (isMonitorGroup(this.monitor)) {
      if (this.monitor.claude) this.registerMonitor('claude', this.monitor.claude);
      if (this.monitor.codex) this.registerMonitor('codex', this.monitor.codex);
      return;
    }
    this.registerMonitor('claude', this.monitor);
  }
}

// === AFTER: auto-thread/index.ts ===

import type { SessionMonitorProvider } from '../usage-monitor/index.ts';

export class AutoThreadDiscovery {
  constructor(
    private config: AutoThreadConfig,
    private monitor: SessionMonitorProvider,       // ← 단일 인터페이스
    private channelRegistry: ChannelRegistry,
    private discordClient: DiscordClient,
    private getThreadRoutes: () => Map<string, DiscordThreadRoute>,
  ) {}

  // bindMonitors() 제거 — init()에서 바로:
  async init(): Promise<void> {
    if (!this.config.enabled) return;
    await this.load();
    this.monitor.onRefresh((sessions) => this.onMonitorRefresh(sessions));
    console.log('[AutoThread] initialized');
  }

  // 제거 대상: AutoThreadMonitorGroup, AutoThreadMonitorInput,
  //           isMonitorGroup(), bindMonitors(), registerMonitor(),
  //           ensureSnapshotProvider(), monitorSessionsByProvider,
  //           mergeMonitorSessions()
  // → 머지는 UsageMonitor가 이미 해줌
}
```

### 3.3 Flow

```
UsageMonitor.init()
  ├── claude-monitor.init()  ──→ onRefresh 콜백 등록
  └── codex-monitor.init()   ──→ onRefresh 콜백 등록

어느 프로바이더의 onRefresh 발생 시:
  1. 해당 프로바이더의 세션 캐시 업데이트
  2. 모든 프로바이더 세션 머지 (sessionId 기준 dedup, 최신 우선)
  3. UsageMonitor.onRefreshCallbacks 호출 (머지된 세션 전달)
     └── auto-thread.onMonitorRefresh(mergedSessions)
```

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/monitor/` (전체 디렉토리) | 삭제 → `src/usage-monitor/`로 이동 | 높음 |
| `src/codex-monitor/` (전체 디렉토리) | 삭제 → `src/usage-monitor/codex-monitor.ts`로 이동 | 높음 |
| `src/auto-thread/index.ts` | `AutoThreadMonitorGroup` 제거, `UsageMonitor` 받도록 변경 | 중간 |
| `src/auto-thread/types.ts` | import 경로 변경 | 낮음 |
| `src/auto-thread/formatter.ts` | import 경로 변경 | 낮음 |
| `src/auto-thread/monitor-log.ts` | import 경로 변경 | 낮음 |
| `src/auto-thread/monitor-log.test.ts` | import 경로 변경 | 낮음 |
| `src/index.ts` | re-export 경로 변경 | 낮음 |

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| class | `UsageMonitor` | 통합 모니터 — 여러 프로바이더 집계. `addProvider()`로 등록 |
| class | `ClaudeUsageMonitor` | Claude Code 세션 프로바이더 (기존 `ClaudeSessionMonitor` rename) |
| class | `CodexUsageMonitor` | Codex 세션 프로바이더 (기존 `CodexSessionMonitor` rename) |
| interface | `SessionMonitorProvider` | 프로바이더 공통 인터페이스 |
| file | `src/usage-monitor/index.ts` | UsageMonitor + SessionMonitorProvider + re-exports |
| file | `src/usage-monitor/claude-monitor.ts` | ClaudeUsageMonitor (monitor/index.ts에서 이동 + rename) |
| file | `src/usage-monitor/codex-monitor.ts` | CodexUsageMonitor (codex-monitor/index.ts에서 이동 + rename) |
| file | `src/usage-monitor/types.ts` | SessionSnapshot, MonitorStatus, ActivityPhase 등 |
| file | `src/usage-monitor/claude-discovery.ts` | getClaudeProcesses, enrichProcesses 등 |
| file | `src/usage-monitor/claude-parser.ts` | tailJsonl, extractSessionInfo |
| file | `src/usage-monitor/activity-phase.ts` | determineActivityPhase |
| file | `src/usage-monitor/formatter.ts` | formatSessionsText/Embed 등 |
| file | `src/usage-monitor/token-usage.ts` | formatTokenUsageText/Embed (format만 유지, measureTokenUsage 제거) |
| method | `getTokenUsageReport()` | SessionMonitorProvider 메서드 — 프로바이더별 pricing 적용 리포트 반환 |
| provider key | `'claude'` | UsageMonitor.addProvider key for Claude |
| provider key | `'codex'` | UsageMonitor.addProvider key for Codex |

## 4. Verification Criteria

- [ ] Given: `src/usage-monitor/` 생성 + `src/monitor/`, `src/codex-monitor/` 삭제 완료 / When: `npx tsc --noEmit` / Then: 타입 에러 없음
- [ ] Given: claude provider가 `[{provider:'claude', sessionId:'abc', state:'active', lastActivity: t1}]` 반환, codex provider가 `[{provider:'codex', sessionId:'xyz', state:'idle', lastActivity: t2}]` 반환 / When: `usageMonitor.getAll()` / Then: `[{provider:'claude', sessionId:'abc'}, {provider:'codex', sessionId:'xyz'}]` (state 우선 정렬: active > idle)
- [ ] Given: dedup key = `provider:sessionId`. claude가 `{sessionId:'s1', lastActivity: t1}`, codex가 `{sessionId:'s1', lastActivity: t2, t2>t1}` / When: `getAll()` / Then: codex 쪽만 반환 (최신 lastActivity 우선)
- [ ] Given: claude provider만 onRefresh 발생 (codex 세션 1개 기존 캐시) / When: UsageMonitor onRefresh 콜백 / Then: 콜백에 claude + codex 머지된 전체 세션 전달
- [ ] Given: `AutoThreadDiscovery(config, usageMonitor, ...)` — 단일 `SessionMonitorProvider` / When: 세션 감지 → 스레드 생성 / Then: provider별 스레드 생성 동작 기존과 동일
- [ ] Given: 기존 테스트 전체 / When: `bun test` / Then: 전부 통과
- [ ] No regression on existing features

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| import 경로 누락으로 런타임 에러 | 높음 | `npx tsc --noEmit` + `bun test`로 전수 검증 |
| auto-thread 인터페이스 변경으로 기존 동작 깨짐 | 중간 | auto-thread의 `AutoThreadSessionMonitor` 인터페이스를 `SessionMonitorProvider`로 대체하되 필요 메서드 동일 |
| 외부 소비자(플러그인)가 `monitor/` 직접 import | 낮음 | src/index.ts re-export만 변경하면 됨 (플러그인은 pray-bot 패키지에서 import) |

<!-- ═══════════════════════════════════════════ -->
<!-- Iterative — Updated each loop              -->
<!-- ═══════════════════════════════════════════ -->

## 6. Task Checklist

> Mark `[x]` only after verify passes.

- [x] ✅ Step 1: `src/usage-monitor/` 디렉토리 생성 + types.ts 이동 → verify: `npx tsc --noEmit` 통과
- [x] ✅ Step 2: `monitor/activity-phase.ts` → `usage-monitor/activity-phase.ts` 이동 → verify: `npx tsc --noEmit`
- [x] ✅ Step 3: `monitor/discovery.ts` → `usage-monitor/claude-discovery.ts` 이동 → verify: `npx tsc --noEmit`
- [x] ✅ Step 4: `monitor/parser.ts` → `usage-monitor/claude-parser.ts` 이동 → verify: `npx tsc --noEmit`
- [x] ✅ Step 5: `monitor/index.ts` → `usage-monitor/claude-monitor.ts` 이동 + `ClaudeSessionMonitor` → `ClaudeUsageMonitor` rename (내부 import 경로 수정) → verify: `npx tsc --noEmit`
- [x] ✅ Step 6: `monitor/formatter.ts` → `usage-monitor/formatter.ts` 이동 → verify: `npx tsc --noEmit`
- [x] ✅ Step 7: `monitor/token-usage.ts` → `usage-monitor/token-usage.ts` 이동 — `measureTokenUsage()` standalone 함수 제거, format 함수만 유지. `ClaudeUsageMonitor`/`CodexUsageMonitor`에 `getTokenUsageReport()` 구현 추가 → verify: `npx tsc --noEmit`
- [x] ✅ Step 8: `codex-monitor/index.ts` → `usage-monitor/codex-monitor.ts` 이동 + `CodexSessionMonitor` → `CodexUsageMonitor` rename (내부 import 경로 수정) → verify: `npx tsc --noEmit`
- [x] ✅ Step 9: `usage-monitor/index.ts` 생성 — `SessionMonitorProvider` 인터페이스 + `UsageMonitor` 클래스 + 모든 re-export → verify: `npx tsc --noEmit`
- [x] ✅ Step 10: `auto-thread/index.ts` 변경 — `AutoThreadMonitorGroup`/`AutoThreadMonitorInput` 제거, 생성자가 `SessionMonitorProvider` 하나만 받도록 수정 → verify: `npx tsc --noEmit`
- [x] ✅ Step 11: `auto-thread/` 나머지 파일 import 경로 수정 (`../monitor/types.ts` → `../usage-monitor/types.ts`) → verify: `npx tsc --noEmit`
- [x] ✅ Step 12: `src/index.ts` re-export 변경 (`monitor/`, `codex-monitor/` → `usage-monitor/`) → verify: `npx tsc --noEmit`
- [x] ✅ Step 13: 기존 테스트 이동 — `monitor/index.test.ts` → `usage-monitor/__tests__/claude-monitor.test.ts`, `codex-monitor/index.test.ts` → `usage-monitor/__tests__/codex-monitor.test.ts`, `monitor/__tests__/activity-phase.test.ts` 이동 + import 수정 → verify: `bun test`
- [x] ✅ Step 14: UsageMonitor 통합 테스트 작성 — 두 프로바이더 머지, onRefresh 콜백 → verify: `bun test`
- [x] ✅ Step 15: `src/monitor/`, `src/codex-monitor/` 디렉토리 삭제 → verify: `npx tsc --noEmit && bun test`

## 7. Open Questions

(없음)

<!-- ═══════════════════════════════════════════ -->
<!-- Cumulative — Append-only, never delete     -->
<!-- ═══════════════════════════════════════════ -->

## 8. Decision Log

## 9. Handoff Snapshot

## 10. Changelog

| rev | date | summary |
|-----|------|---------|
| 1 | 2026-02-17 | Initial draft |
| 2 | 2026-02-17 | Review feedback: UsageMonitorOptions/getProvider 제거, 머지 로직 코드 블록 추가, §4 concrete assertions, auto-thread before/after 명시 |
| 3 | 2026-02-17 | ClaudeSessionMonitor → ClaudeUsageMonitor, CodexSessionMonitor → CodexUsageMonitor rename |
| 4 | 2026-02-17 | getTokenUsageReport()를 SessionMonitorProvider 인터페이스에 추가, measureTokenUsage() standalone 제거, 프로바이더별 pricing 내장 |
