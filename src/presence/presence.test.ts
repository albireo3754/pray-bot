import { describe, expect, test } from 'bun:test';
import { DiscordPresence } from './discord-presence.ts';

describe('DiscordPresence', () => {
  test('startWorking sends typing immediately once', () => {
    let callCount = 0;
    const mockClient = {
      sendTyping: async (_channelId: string) => {
        callCount += 1;
      },
    };

    const presence = new DiscordPresence(mockClient, 'channel-1');
    presence.startWorking();
    presence.startWorking();

    expect(callCount).toBe(1);
    presence.stopWorking();
    presence.stopWorking();
  });
});
