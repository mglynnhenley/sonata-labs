// Populate snapshot.db with the synthetic Acme advertiser account, then copy it
// to working.db. Lets the API be developed and demoed with no Google Ads
// account and no orchestrator.
//
//   npm run seed

import Database from "better-sqlite3";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { ensureDataDir, readSchema, SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";
import { seedDatabase } from "../lib/seed.js";
import { countCampaigns } from "../lib/store/campaigns.js";
import { countAdGroups } from "../lib/store/adGroups.js";
import { countBudgets } from "../lib/store/budgets.js";
import { countStatRows, distinctDates } from "../lib/store/stats.js";

const SUFFIXES = ["", "-wal", "-shm"];
function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

ensureDataDir();

console.log("Seeding snapshot.db with a synthetic Google Ads account…");
rmFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.exec(readSchema());
seedDatabase(db);
const counts = {
  campaigns: countCampaigns(db),
  adGroups: countAdGroups(db),
  budgets: countBudgets(db),
  statRows: countStatRows(db),
  days: distinctDates(db).length,
};
// One self-contained file to copy: without this the WAL still holds the writes.
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log("Copying snapshot.db → working.db…");
rmFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

console.log(
  `Done. ${counts.campaigns} campaigns, ${counts.adGroups} ad groups, ${counts.budgets} budgets, ` +
    `${counts.statRows} stat rows across ${counts.days} days.`,
);
if (!existsSync(WORKING_PATH)) throw new Error("working.db was not created");
