/** 플랫폼별 "작업 중" 표시를 추상화 */
export interface PresenceGateway {
  startWorking(label?: string): void;
  stopWorking(): void;
  ping(): void;
}
