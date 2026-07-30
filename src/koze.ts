import {
  initKuniiORM as initCloudflareORM,
  type KuniiInitOptions,
  type KuniiSchemas,
} from './init.js';

export interface KozeOrmMiddlewareOptions {
  /**
   * Optional ctx.locals key for request-scoped clients. Disabled by default
   * to match the older autoMigrate-only middleware behavior.
   */
  locals?: string | false;
}

export function initKuniiORM<Schemas extends KuniiSchemas>(
  schemas: Schemas,
  options: KuniiInitOptions = {},
) {
  const runtime = initCloudflareORM(schemas, {
    ...options,
    label: options.label ?? 'koze',
  });

  return {
    ...runtime,
    middleware(middlewareOptions: KozeOrmMiddlewareOptions = {}) {
      return {
        async request(ctx: any, next: () => Promise<Response>): Promise<Response> {
          await runtime.migrateOnce(ctx?.env);
          if (middlewareOptions.locals) {
            ctx.locals ??= {};
            ctx.locals[middlewareOptions.locals] = runtime.clients(ctx.env);
          }
          return next();
        },
      };
    },
  };
}

/** @deprecated Use `initKuniiORM` instead. */
export const initKuratchiORM: typeof initKuniiORM = initKuniiORM;
