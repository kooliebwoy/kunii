export { initKuniiORM, initKuratchiORM } from './koze.js';
export type { KozeOrmMiddlewareOptions } from './koze.js';
import type { KozeOrmMiddlewareOptions } from './koze.js';

/** @deprecated Use `KozeOrmMiddlewareOptions` from `kunii/koze` instead. */
export interface KuratchiOrmMiddlewareOptions extends KozeOrmMiddlewareOptions {}
