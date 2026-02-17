import type { ActionHandler } from './index.ts';

export function createNotifyAction(
  sendNotification: (message: string, platform?: string) => Promise<void>,
): ActionHandler {
  return async (config) => {
    const message = String(config.message ?? '');
    if (!message) {
      return { status: 'error', error: 'No message provided' };
    }

    const platform = config.platform as string | undefined;

    try {
      await sendNotification(message, platform);
      return { status: 'ok', summary: message.slice(0, 100) };
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
