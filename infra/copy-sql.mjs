// The migrations are plain .sql files that tsc does not copy; the server reads them from dist/server/sql at start-up.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
mkdirSync('dist/server/sql', { recursive: true });
for (const f of readdirSync('src/server/sql')) copyFileSync(`src/server/sql/${f}`, `dist/server/sql/${f}`);
