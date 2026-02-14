// One-time script to seed .sync-state.json with all existing meetings
// so sync.js only processes NEW meetings going forward.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming"),
  "Granola",
  "cache-v3.json"
);

const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
const state = JSON.parse(raw.cache).state;
const docs = state.documents || {};

const allIds = Object.keys(docs).filter(id => !docs[id].deleted_at);
const syncState = { processedMeetings: allIds };

fs.writeFileSync(
  path.join(__dirname, ".sync-state.json"),
  JSON.stringify(syncState, null, 2) + "\n"
);

console.log(`Seeded sync state with ${allIds.length} existing meetings.`);
