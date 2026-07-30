import {
  initKuniiORM as initCloudflareORM,
  type KuniiInitOptions,
  type KuniiSchemas,
} from './init.js';

export interface AstroOrmMiddlewareOptions {
  /** context.locals key used for generated clients. Defaults to "kunii". */
  locals?: string;
}

export function initKuniiORM<Schemas extends KuniiSchemas>(
  schemas: Schemas,
  options: KuniiInitOptions = {},
) {
  const runtime = initCloudflareORM(schemas, {
    ...options,
    label: options.label ?? 'astro',
  });

  return {
    ...runtime,
    middleware(middlewareOptions: AstroOrmMiddlewareOptions = {}) {
      const localsKey = middlewareOptions.locals ?? 'kunii';
      return async (context: any, next: () => Promise<Response>): Promise<Response> => {
        const env = context?.locals?.runtime?.env ?? context?.runtime?.env;
        await runtime.migrateOnce(env);
        context.locals ??= {};
        context.locals[localsKey] = runtime.clients(env);
        return next();
      };
    },
  };
}

/** @deprecated Use `initKuniiORM` instead. */
export const initKuratchiORM: typeof initKuniiORM = initKuniiORM;
