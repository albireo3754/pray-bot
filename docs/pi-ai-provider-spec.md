# Pi-AI Provider Integration Spec (Draft)

- **Author:** yuna
- **Status:** Draft
- **Target Repo:** `albireo3754/pray-bot`
- **Last Updated:** 2026-02-17 (KST)

## 1) Background

`pray-bot` currently supports these providers:

- `codex`
- `claude`
- `gemini`

To support additional model backends, we propose introducing a new provider: **`pi-ai`**.

This document defines the baseline contract, implementation scope, and rollout plan for adding `pi-ai` while preserving current architecture (`AgentProvider` / `AgentSession`).

## 2) Goals

1. Add `pi-ai` as a first-class provider in the existing abstraction layer.
2. Keep compatibility with current command and session flow.
3. Minimize risk by shipping in phases (skeleton → basic turn loop → streaming/tooling hardening).

## 3) Non-Goals (initial phase)

- Full parity with every advanced provider feature on day one
- Complex multi-agent orchestration unique to `pi-ai`
- Provider-specific UX features that break the unified event model

## 4) Current Architecture Constraints

Relevant interfaces:

- `src/agents/types.ts`
  - `ProviderId` (currently `'codex' | 'claude' | 'gemini'`)
  - `AgentProvider`
  - `AgentSession`
- `src/agents/manager.ts`
  - provider registration and session routing

New provider must map `pi-ai` events into existing unified `AgentEvent` union.

## 5) Proposed Changes

### 5.1 Type-level updates

1. Extend `ProviderId`:

```ts
export type ProviderId = 'codex' | 'claude' | 'gemini' | 'pi-ai';
```

2. Keep existing `AgentEvent` model; do not add provider-specific event types in v1.

### 5.2 New provider implementation

Create:

- `src/agents/providers/pi-ai.ts`

Responsibilities:

- `initialize()`
  - validate required env vars
  - initialize SDK/client
- `createSession(options)`
  - create a provider session object implementing `AgentSession`
- `isAvailable()`
  - return boolean based on env/config + client readiness
- `capabilities()`
  - explicit capability matrix

### 5.3 Session behavior

`PiAiSession` should implement:

- `send(message)` as `AsyncIterable<AgentEvent>`
- `interrupt()` (real cancellation if supported, otherwise noop)
- `getStatus()`
- `close()`

Mapping rules (minimum):

- model text chunks → `type: 'text'`
- session id events (if available) → `type: 'session'`
- terminal response completion → `type: 'turn_complete'`
- provider errors → `type: 'error'`

### 5.4 Env/config additions

Add `.env.example` entries:

- `PIAI_API_KEY=`
- `PIAI_MODEL=` (optional default)
- `PIAI_BASE_URL=` (optional, if self-hosted/proxy)

### 5.5 Provider registration

Update startup wiring to register `PiAiProvider` with `AgentSessionManager`.

Potential toggle:

- register only if env is present (`PIAI_API_KEY`) to avoid noisy boot errors.

## 6) Capability Baseline (v1 target)

| Capability | Target |
|---|---|
| streaming | yes (if API supports) |
| multiTurn | yes |
| toolUse | no (v1), or passthrough if trivial |
| systemPrompt | yes |
| sessionResume | no (v1) |
| subagents | no |
| mcp | no |
| interrupt | best-effort |
| sandbox | n/a |
| budgetControl | no (v1) |
| structuredOutput | optional |

## 7) Error Handling

- Normalize transport/API failures into recoverable `AgentErrorEvent` where possible.
- Include safe diagnostic message without leaking secrets.
- Retry strategy (v1): conservative, small retry count for transient network errors only.

## 8) Security Considerations

- Never log raw API keys.
- Redact authorization headers from debug output.
- Keep provider-specific secrets isolated to env.

## 9) Rollout Plan

### Phase 1 — Skeleton

- add `ProviderId`
- add `pi-ai.ts` scaffold
- wire registration
- pass type-check

### Phase 2 — Functional turn loop

- support `send()` request/response
- map text + completion + errors
- basic tests

### Phase 3 — Hardening

- improve streaming semantics
- cancellation/interrupt behavior
- resilience and observability improvements

## 10) Test Plan

### 10.1 Baseline for early integration tests

For initial validation in local/dev environments, use **Codex OAuth** as the default baseline authentication path when testing shared orchestration behavior around provider switching and session handling.

- Rationale: Codex OAuth is already used in the current environment and provides a stable control baseline.
- Scope: This baseline is for integration sanity checks (session wiring, routing, command flow), not as a substitute for `pi-ai` auth tests.
- Requirement: `pi-ai` provider itself must still be tested with its own credentials/API path before production use.

### 10.2 Test checklist

1. Unit tests for event mapping (`pi-ai response -> AgentEvent[]`)
2. Session lifecycle tests (`create -> send -> close`)
3. Error-path tests (auth failure, network timeout)
4. Manual discord channel smoke test with provider switch
5. Cross-check against Codex OAuth baseline behavior (turn lifecycle, stream completion, recoverable errors)

## 11) Open Questions

1. Which `pi-ai` API mode is canonical (official SDK vs OpenAI-compatible endpoint)?
2. Does `pi-ai` expose native conversation/session ids suitable for resume?
3. Are tool-call semantics available and worth mapping in v1?

## 12) Definition of Done (for initial merge)

- [ ] `ProviderId` includes `pi-ai`
- [ ] `PiAiProvider` compiles and registers
- [ ] `.env.example` updated
- [ ] basic docs added (this spec + short README note)
- [ ] CI/typecheck passes

---

If approved, this spec becomes the implementation checklist for the first `pi-ai` provider PR.
