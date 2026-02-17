# Usage Monitor Refactor — Task State
> spec: docs/usage-monitor-refactor.md | created: 2026-02-17 | updated: 2026-02-17

## Dependency Analysis
Sequential chain: All 15 steps are sequential. Each step depends on the previous step's file moves/renames being complete.

Batching strategy:
- Batch A (Steps 1-6): Create usage-monitor/ + move types, activity-phase, discovery, parser, claude-monitor, formatter
- Batch B (Steps 7-9): Move token-usage, codex-monitor, create UsageMonitor index
- Batch C (Steps 10-12): Update auto-thread, update src/index.ts re-exports
- Batch D (Steps 13-15): Move tests, write integration test, delete old dirs

## Tasks
| # | Task | Status | Agent | Started | Completed |
|---|------|--------|-------|---------|-----------|
| 1 | Create usage-monitor/ + move types.ts | completed | lead | 2026-02-17 | 2026-02-17 |
| 2 | Move activity-phase.ts | completed | lead | 2026-02-17 | 2026-02-17 |
| 3 | Move discovery.ts → claude-discovery.ts | completed | lead | 2026-02-17 | 2026-02-17 |
| 4 | Move parser.ts → claude-parser.ts | completed | lead | 2026-02-17 | 2026-02-17 |
| 5 | Move monitor/index.ts → claude-monitor.ts + rename class | completed | lead | 2026-02-17 | 2026-02-17 |
| 6 | Move formatter.ts | completed | lead | 2026-02-17 | 2026-02-17 |
| 7 | Move token-usage.ts (remove measureTokenUsage, add getTokenUsageReport) | completed | lead | 2026-02-17 | 2026-02-17 |
| 8 | Move codex-monitor + rename class | completed | lead | 2026-02-17 | 2026-02-17 |
| 9 | Create UsageMonitor index.ts | completed | lead | 2026-02-17 | 2026-02-17 |
| 10 | Update auto-thread/index.ts (remove MonitorGroup, use SessionMonitorProvider) | completed | lead | 2026-02-17 | 2026-02-17 |
| 11 | Update auto-thread/ remaining imports | completed | lead | 2026-02-17 | 2026-02-17 |
| 12 | Update src/index.ts re-exports | completed | lead | 2026-02-17 | 2026-02-17 |
| 13 | Move tests + fix imports | completed | lead | 2026-02-17 | 2026-02-17 |
| 14 | Write UsageMonitor integration test | completed | lead | 2026-02-17 | 2026-02-17 |
| 15 | Delete old dirs (monitor/, codex-monitor/) | completed | lead | 2026-02-17 | 2026-02-17 |
| 16 | claude-parser fixture test (tailJsonl + extractSessionInfo with real JSONL) | completed | lead | 2026-02-17 | 2026-02-17 |
| 17 | JSONL pipeline integration test (real parser, temp JSONL files) | completed | lead | 2026-02-17 | 2026-02-17 |

## Session Log
### 2026-02-17 — Session 1
- Completed: All 15 steps
- Batched execution: A(1-6), B(7-9), C(10-12), D(13-15)
- Key decisions: EmbedData not re-exported from usage-monitor (conflict with discord/types.ts); TokenUsageSession/TokenUsageReport types moved to usage-monitor/types.ts
- Verification: `npx tsc --noEmit` ✅ | `bun test` 71/71 pass ✅

### 2026-02-17 — Session 2
- Completed: Tasks 16-17 (fixture-based parser + pipeline integration tests)
- Task 16: `claude-parser.test.ts` — 13 test cases covering tailJsonl, extractSessionInfo, determineActivityPhase with real JSONL files in temp dirs
- Task 17: `jsonl-pipeline.test.ts` — 4 test cases covering full JSONL→SessionInfo pipeline with multi-turn sessions, tool resolution, AskUserQuestion, and token cost estimation
- Key decisions:
  - Renamed integration test from `claude-monitor-integration.test.ts` to `jsonl-pipeline.test.ts` to avoid Bun mock.module leak (Bun leaks mocks between test files sharing filename prefix)
  - Used `await import(join(import.meta.dir, '...'))` to bypass Bun's global mock.module scope (absolute paths are not intercepted by mock.module)
  - Integration test directly calls parser pipeline (not via ClaudeUsageMonitor) to avoid transitive mock contamination
- Verification: `npx tsc --noEmit` ✅ | `bun test` 88/88 pass ✅
