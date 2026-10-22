import type { Migration } from "kysely";
import * as m0001 from "./0001_foundation.js";
import * as m0002 from "./0002_tenancy_identity.js";
import * as m0003 from "./0003_metadata.js";

/**
 * Every migration, in order. Listed statically so they load the same way under
 * tsx, Vitest and a bundled build, and a missing file fails at compile time.
 * Add new migrations at the end; never rename or reorder existing ones.
 */
export const migrations: Record<string, Migration> = {
  "0001_foundation": m0001,
  "0002_tenancy_identity": m0002,
  "0003_metadata": m0003,
};
