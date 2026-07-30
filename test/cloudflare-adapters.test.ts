import { describe, expect, it } from 'vitest';
import { initKuniiORM as initAstroOrm } from '../src/astro.js';
import { initKuniiORM as initKozeOrm } from '../src/koze.js';
import { initKuratchiORM as initKuratchiMiddlewareOrm } from '../src/kuratchi-js.js';
import { initKuniiORM as initNextOrm } from '../src/next.js';
import { initKuniiORM as initNuxtOrm } from '../src/nuxt.js';
import { initKuniiORM as initSvelteKitOrm } from '../src/sveltekit.js';
import { appSchema, MockD1Database } from './cloudflare-helpers.js';

describe('Cloudflare framework adapters', () => {
  it('creates a Koze middleware step', async () => {
    const d1 = new MockD1Database();
    const orm = initKozeOrm({ DB: appSchema });
    const middleware = orm.middleware({ locals: 'kunii' });

    const response = await middleware.request(
      { env: { DB: d1 }, locals: {} },
      async () => new Response('ok')
    );

    expect(await response.text()).toBe('ok');
    expect(d1.batches).toHaveLength(1);
  });

  it('keeps the deprecated Koze adapter alias', async () => {
    const d1 = new MockD1Database();
    const orm = initKuratchiMiddlewareOrm({ DB: appSchema });
    const middleware = orm.middleware({ locals: 'kuratchi' });

    const response = await middleware.request(
      { env: { DB: d1 }, locals: {} },
      async () => new Response('ok')
    );

    expect(await response.text()).toBe('ok');
    expect(d1.batches).toHaveLength(1);
  });

  it('stores clients on SvelteKit event.locals', async () => {
    const d1 = new MockD1Database();
    const orm = initSvelteKitOrm({ DB: appSchema });
    const handle = orm.handle();
    const event = { platform: { env: { DB: d1 } }, locals: {} as any };

    await handle({
      event,
      resolve: async () => new Response('sveltekit'),
    });

    expect(event.locals.kunii.DB).toBeTruthy();
  });

  it('stores clients on Astro context.locals', async () => {
    const d1 = new MockD1Database();
    const orm = initAstroOrm({ DB: appSchema });
    const middleware = orm.middleware();
    const context = { locals: { runtime: { env: { DB: d1 } } } as any };

    const response = await middleware(context, async () => new Response('astro'));

    expect(await response.text()).toBe('astro');
    expect(context.locals.kunii.DB).toBeTruthy();
  });

  it('stores clients on Nuxt event.context', async () => {
    const d1 = new MockD1Database();
    const orm = initNuxtOrm({ DB: appSchema });
    const eventHandler = orm.eventHandler();
    const event = { context: { cloudflare: { env: { DB: d1 } } } as any };

    await eventHandler(event);

    expect(event.context.kunii.DB).toBeTruthy();
  });

  it('wraps Next route handlers with migrated clients', async () => {
    const d1 = new MockD1Database();
    const orm = initNextOrm({
      DB: appSchema,
    }, {
      bindings: async () => ({ DB: d1 }),
    });

    const GET = orm.route(async ({ db }) => {
      await db.DB.todos.many();
      return new Response('next');
    });

    const response = await GET(new Request('https://example.com'));

    expect(await response.text()).toBe('next');
    expect(d1.calls.at(-1)?.sql).toBe('SELECT * FROM todos');
  });
});
