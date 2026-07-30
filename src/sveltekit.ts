import {
  initKuniiORM as initCloudflareORM,
  type KuniiInitOptions,
  type KuniiSchemas,
} from './init.js';

export interface SvelteKitOrmHandleOptions {
  /** event.locals key used for generated clients. Defaults to "kunii". */
  locals?: string;
}

export function initKuniiORM<Schemas extends KuniiSchemas>(
  schemas: Schemas,
  options: KuniiInitOptions = {},
) {
  const runtime = initCloudflareORM(schemas, {
    ...options,
    label: options.label ?? 'sveltekit',
  });

  return {
    ...runtime,
    handle(handleOptions: SvelteKitOrmHandleOptions = {}) {
      const localsKey = handleOptions.locals ?? 'kunii';
      return async ({ event, resolve }: any): Promise<Response> => {
        const env = event?.platform?.env;
        await runtime.migrateOnce(env);
        event.locals ??= {};
        event.locals[localsKey] = runtime.clients(env);
        return resolve(event);
      };
    },
  };
}

/** @deprecated Use `initKuniiORM` instead. */
export const initKuratchiORM: typeof initKuniiORM = initKuniiORM;
