import { createAi } from './ai.js';
import { buildApp } from './app.js';
import { createBlobStore } from './blob.js';
import { config } from './config.js';
import type { Ctx } from './context.js';
import { pgDb } from './db.js';
import { createGraph } from './graph.js';
import { itsmSetupFromConfig } from './itsm.js';
import { createMailer } from './mail.js';
import { createVault } from './secrets.js';
import { migrate } from './migrate.js';
import { seedPeople } from './seed.js';
import { prepareOvertime } from './overtime.js';
import { istanbulNow, startJobs } from './scheduler.js';

if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const db = pgDb(config.DATABASE_URL);
console.log('migrations applied:', await migrate(db));
console.log('people seeded:', await seedPeople(db));
console.log('overtime ready:', await prepareOvertime(db, Number(istanbulNow().date.slice(0, 4))));

const graph = createGraph();
const vault = createVault();
const itsm = itsmSetupFromConfig();
const ctx: Ctx = { db, ai: createAi(), blob: createBlobStore(), vault, itsm, today: () => istanbulNow().date };

// A cheap query every few minutes keeps at least one database connection warm.
setInterval(() => { void db.query('SELECT 1').catch(() => {}); }, 4 * 60_000).unref();

buildApp(ctx, graph).listen(config.PORT, () => console.log(`Efor listening on :${config.PORT} (auth: ${config.AUTH_MODE})`));
startJobs(db, graph, createMailer(), itsm, vault);
