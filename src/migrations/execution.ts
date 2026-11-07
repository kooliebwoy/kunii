import type { FullDbClient, QueryResult } from '../types.js';

export type MigrationExecutor = (sql: string, params?: any[]) => QueryResult<any> | Promise<QueryResult<any>>;
export type MigrationClient = Omit<FullDbClient, 'batch'> & {
  batch?: (statements: any[]) => unknown;
};
export type MigrationSteps<T> = Generator<unknown, T, any>;

/** Feed asynchronous results and failures back into the shared migration program. */
export async function runAsync<T>(steps: MigrationSteps<T>): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    let result: unknown;
    try {
      result = await step.value;
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(result);
  }
  return step.value;
}

/** No asynchronous boundary is allowed inside a DO transactionSync callback. */
export function runSync<T>(steps: MigrationSteps<T>): T {
  let step = steps.next();
  while (!step.done) {
    if (step.value && typeof (step.value as any).then === 'function') {
      steps.return(undefined as T);
      throw new Error('Synchronous migrations require synchronous storage operations');
    }
    step = steps.next(step.value);
  }
  return step.value;
}
