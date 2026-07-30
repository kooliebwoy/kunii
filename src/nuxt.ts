import {
  initKuniiORM as initCloudflareORM,
  type KuniiInitOptions,
  type KuniiSchemas,
} from './init.js';

export interface NuxtOrmEventHandlerOptions {
  /** event.context key used for generated clients. Defaults to "kunii". */
  context?: string;
}

export function initKuniiORM<Schemas extends KuniiSchemas>(
  schemas: Schemas,
  options: KuniiInitOptions = {},
) {
  const runtime = initCloudflareORM(schemas, {
    ...options,
    label: options.label ?? 'nuxt',
  });

  return {
    ...runtime,
    eventHandler(handlerOptions: NuxtOrmEventHandlerOptions = {}) {
      const contextKey = handlerOptions.context ?? 'kunii';
      return async (event: any): Promise<void> => {
        const env = event?.context?.cloudflare?.env;
        await runtime.migrateOnce(env);
        event.context ??= {};
        event.context[contextKey] = runtime.clients(env);
      };
    },
  };
}

/** @deprecated Use `initKuniiORM` instead. */
export const initKuratchiORM: typeof initKuniiORM = initKuniiORM;
