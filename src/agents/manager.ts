/**
 * AgentSessionManager - 세션 풀 + Provider 라우팅
 *
 * 모든 LLM 세션의 생성/조회/삭제를 관리.
 */

import type {
  ProviderId,
  AgentProvider,
  AgentSession,
  SessionOptions,
  SessionStatus,
  ProviderCapabilities,
} from './types.ts';

export class AgentSessionManager {
  private providers = new Map<ProviderId, AgentProvider>();
  private sessions = new Map<string, AgentSession>();
  private _defaultProvider: ProviderId;

  constructor(defaultProvider: ProviderId = 'codex') {
    this._defaultProvider = defaultProvider;
  }

  get defaultProvider(): ProviderId { return this._defaultProvider; }
  set defaultProvider(id: ProviderId) { this._defaultProvider = id; }

  /** Provider 등록 + 초기화 */
  async registerProvider(provider: AgentProvider): Promise<void> {
    try {
      await provider.initialize();
      this.providers.set(provider.id, provider);
      console.log(`[AgentManager] Provider registered: ${provider.id} (${provider.name})`);
    } catch (e) {
      console.warn(`[AgentManager] Provider ${provider.id} init failed:`, e);
    }
  }

  /** Provider 인스턴스 접근 */
  getProvider(id?: ProviderId): AgentProvider | undefined {
    return this.providers.get(id ?? this._defaultProvider);
  }

  /** 세션 생성 */
  async createSession(key: string, options?: SessionOptions): Promise<AgentSession> {
    const providerId = options?.provider ?? this._defaultProvider;
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider not registered: ${providerId}`);

    // 기존 세션 정리
    const existing = this.sessions.get(key);
    if (existing && existing.getStatus().state !== 'closed') {
      await existing.close();
    }

    const session = await provider.createSession(options ?? {});
    this.sessions.set(key, session);
    return session;
  }

  /** 세션 조회 */
  getSession(key: string): AgentSession | undefined {
    return this.sessions.get(key);
  }

  /** 세션 존재 여부 */
  hasSession(key: string): boolean {
    return this.sessions.has(key);
  }

  /** 세션 제거 */
  async removeSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session) {
      await session.close();
      this.sessions.delete(key);
    }
  }

  /** 활성 세션 키 목록 */
  activeKeys(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** /health, /api/status용 전체 상태 */
  getStatus(): Record<string, { provider: ProviderId; status: SessionStatus }> {
    const result: Record<string, { provider: ProviderId; status: SessionStatus }> = {};
    for (const [key, session] of this.sessions) {
      result[key] = { provider: session.providerId, status: session.getStatus() };
    }
    return result;
  }

  /** /provider 명령어용 */
  listProviders(): Array<{ id: ProviderId; name: string; available: boolean; capabilities: ProviderCapabilities }> {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      available: p.isAvailable(),
      capabilities: p.capabilities(),
    }));
  }

  listSessions(): Array<{ key: string; provider: ProviderId; state: string }> {
    return Array.from(this.sessions.entries()).map(([key, s]) => ({
      key,
      provider: s.providerId,
      state: s.getStatus().state,
    }));
  }
}
