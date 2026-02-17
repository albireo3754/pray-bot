import type { CronSchedulerState } from './state.ts';

export async function locked<T>(state: CronSchedulerState, fn: () => Promise<T>): Promise<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const next = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const prev = state.op;
  state.op = next.catch(() => {});
  await prev.catch(() => {});
  try {
    const result = await fn();
    resolve(result);
    return result;
  } catch (e) {
    reject(e);
    throw e;
  }
}
