import type { Ai } from './ai.js';
import type { BlobStore } from './blob.js';
import type { Db } from './db.js';
import type { ItsmSetup } from './itsm.js';
import type { Vault } from './secrets.js';

export interface Ctx {
  db: Db;
  ai: Ai;
  blob: BlobStore;
  vault: Vault;
  itsm: ItsmSetup;
  /** Today as YYYY-MM-DD; injectable so tests are deterministic. */
  today: () => string;
}
