import type { CronJob } from '../types.ts';
import type { CronActionExecutor } from '../state.ts';
import { createNotifyAction } from './notify.ts';
import { createHttpAction } from './http.ts';

export type ActionHandler = (
  config: Record<string, unknown>,
  job: CronJob,
) => Promise<{ status: 'ok' | 'error'; summary?: string; error?: string }>;

export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>();

  register(type: string, handler: ActionHandler): void {
    this.handlers.set(type, handler);
  }

  get(type: string): ActionHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }
}

export interface BuiltinActionDeps {
  /** Function to send a notification message */
  sendNotification: (message: string, platform?: string) => Promise<void>;
}

export function createBuiltinActions(deps: BuiltinActionDeps): CronActionExecutor {
  const registry = new ActionRegistry();

  registry.register('notify', createNotifyAction(deps.sendNotification));
  registry.register('http', createHttpAction());

  return async (job: CronJob) => {
    const handler = registry.get(job.action.type);
    if (!handler) {
      return { status: 'error', error: `Unknown action type: ${job.action.type}` };
    }
    return handler(job.action.config, job);
  };
}
