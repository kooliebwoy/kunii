import {
  initKuniiORM as initCloudflareORM,
  type KuniiEnv,
  type KuniiClients,
  type KuniiInitOptions,
  type KuniiSchemas,
} from './init.js';

type NextRouteContext = any;

export type NextBindingsResolver = (context: {
  request: Request;
  routeContext: NextRouteContext;
}) => KuniiEnv | Promise<KuniiEnv>;

export type NextOrmRouteHandler<Schemas extends KuniiSchemas> = (context: {
  request: Request;
  routeContext: NextRouteContext;
  env: KuniiEnv;
  db: KuniiClients<Schemas>;
}) => Response | Promise<Response>;

export interface NextOrmInitOptions extends KuniiInitOptions {
  /**
   * Override binding lookup. When omitted, the adapter reads
   * @opennextjs/cloudflare's getCloudflareContext().
   */
  bindings?: NextBindingsResolver;
}

async function getOpenNextEnv(): Promise<KuniiEnv> {
  const openNextPackage = '@opennextjs/cloudflare';
  try {
    const mod: any = await import(openNextPackage);
    const context = await mod.getCloudflareContext?.();
    const env = context?.env;
    if (env) return env;
  } catch (error: any) {
    throw new Error(
      `[kunii/next] Unable to load Cloudflare env from @opennextjs/cloudflare: ${error?.message ?? String(error)}`
    );
  }
  throw new Error('[kunii/next] getCloudflareContext() did not return an env object.');
}

export function initKuniiORM<Schemas extends KuniiSchemas>(
  schemas: Schemas,
  options: NextOrmInitOptions = {},
) {
  const runtime = initCloudflareORM(schemas, {
    ...options,
    label: options.label ?? 'next',
  });

  const resolveEnv = async (
    request: Request,
    routeContext: NextRouteContext,
    override?: NextBindingsResolver,
  ): Promise<KuniiEnv> => {
    const resolver = override ?? options.bindings;
    if (resolver) return resolver({ request, routeContext });
    return getOpenNextEnv();
  };

  return {
    ...runtime,
    route(
      handler: NextOrmRouteHandler<Schemas>,
      routeOptions: { bindings?: NextBindingsResolver } = {},
    ) {
      return async (request: Request, routeContext: NextRouteContext = {}): Promise<Response> => {
        const env = await resolveEnv(request, routeContext, routeOptions.bindings);
        await runtime.migrateOnce(env);
        return handler({
          request,
          routeContext,
          env,
          db: runtime.clients(env),
        });
      };
    },
  };
}

/** @deprecated Use `initKuniiORM` instead. */
export const initKuratchiORM: typeof initKuniiORM = initKuniiORM;
