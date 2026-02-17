import type { PresenceGateway } from './types.ts';

export class NullPresence implements PresenceGateway {
  startWorking(): void {}
  stopWorking(): void {}
  ping(): void {}
}
