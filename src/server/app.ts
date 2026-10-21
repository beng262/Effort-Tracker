import express, { type Express } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './auth.js';
import { calendarRouter } from './calendar.js';
import type { Ctx } from './context.js';
import type { Graph } from './graph.js';
import { apiRouter } from './routes.js';
import { loadUser } from './session.js';
import { compressJson, serveFront } from './static.js';

/** The Express app without any listening or background jobs, so tests can drive it directly. */
export function buildApp(ctx: Ctx, graph: Graph): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    next();
  });
  app.use(compressJson);
  app.use(express.json({ limit: '1mb' }));
  app.use(loadUser);
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(authRouter(ctx.db));
  app.use(calendarRouter(ctx));
  app.use(apiRouter(ctx, graph));
  const here = dirname(fileURLToPath(import.meta.url));
  serveFront(app, join(here, '..', '..', 'public'));
  return app;
}
