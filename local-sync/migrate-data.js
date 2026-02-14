#!/usr/bin/env node
/**
 * migrate-data.js — One-time migration from meeting-dashboard/data.json
 * to ts-dashboard's people.json, action-items.json, and interactions.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, "..", "..", "meeting-dashboard", "data.json");
const DATA_DIR = path.join(__dirname, "..", "dashboard", "data");

// --- Known people registry (seed data) ---
const KNOWN_PEOPLE = [
  {
    id: "blake",
    name: "Blake Corbit",
    role: "TS Lead",
    team: "TS",
    email: "blake.corbit@autovitalsinc.com",
    tags: ["manager", "dev"],
    relationships: { reports_to: "cory", manages: ["brien", "jake"] },
  },
  {
    id: "brien",
    name: "Brien Nunn",
    role: "TS Agent",
    team: "TS",
    email: "",
    tags: ["agent"],
    relationships: { reports_to: "blake", manages: [] },
  },
  {
    id: "jake",
    name: "Jacob Ryder",
    role: "TS Agent",
    team: "TS",
    email: "",
    tags: ["agent"],
    relationships: { reports_to: "blake", manages: [] },
  },
  {
    id: "cory",
    name: "Cory Berg",
    role: "Director",
    team: "Engineering",
    email: "",
    tags: ["leadership"],
    relationships: { reports_to: null, manages: ["blake"] },
  },
  {
    id: "ally",
    name: "Ally Prach",
    role: "Product",
    team: "Product",
    email: "",
    tags: ["product"],
    relationships: { reports_to: null, manages: [] },
  },
  {
    id: "jenna",
    name: "Jenna Treat",
    role: "Operations",
    team: "Operations",
    email: "",
    tags: ["ops"],
    relationships: { reports_to: null, manages: [] },
  },
  {
    id: "jennifer",
    name: "Jennifer",
    role: "CS",
    team: "CS",
    email: "",
    tags: ["cs"],
    relationships: { reports_to: null, manages: [] },
  },
];

// Name → ID mapping (handles first names, full names, nicknames)
const NAME_MAP = {};
for (const p of KNOWN_PEOPLE) {
  NAME_MAP[p.name.toLowerCase()] = p.id;
  NAME_MAP[p.name.split(" ")[0].toLowerCase()] = p.id;
}
// Aliases
NAME_MAP["nun"] = "brien";
NAME_MAP["brien nunn"] = "brien";
NAME_MAP["jacob ryder"] = "jake";
NAME_MAP["jacob"] = "jake";
NAME_MAP["cory berg"] = "cory";
NAME_MAP["ally prach"] = "ally";
NAME_MAP["jenna treat"] = "jenna";
// Engineering team
NAME_MAP["alex troy"] = "alex_troy";
NAME_MAP["alex yatsenko"] = "alex_y";
NAME_MAP["alexey"] = "alexey";
NAME_MAP["alexey polovinka"] = "alexey";
NAME_MAP["anatoliy"] = "anatoliy";
NAME_MAP["anatoliy shapoval"] = "anatoliy";
NAME_MAP["shweps"] = "anatoliy";
NAME_MAP["dmitriy"] = "dmitriy";
NAME_MAP["dmitriy karlov"] = "dmitriy";
NAME_MAP["marsel"] = "marsel";
NAME_MAP["marsel fattakhov"] = "marsel";
NAME_MAP["michael"] = "michael_k";
NAME_MAP["michael krits"] = "michael_k";
NAME_MAP["oleg"] = "oleg";
NAME_MAP["oleg rylin"] = "oleg";
NAME_MAP["sergey"] = "sergey";
NAME_MAP["sergey doroshchenko"] = "sergey";
NAME_MAP["slav"] = "slav";
NAME_MAP["slav rilov"] = "slav";
NAME_MAP["ute"] = "ute";
NAME_MAP["ute gerlach"] = "ute";
NAME_MAP["vadim"] = "vadim";
NAME_MAP["vadim loboda"] = "vadim";
NAME_MAP["jenn"] = "jenn_t";
NAME_MAP["jenn thronson"] = "jenn_t";
NAME_MAP["taren"] = "taren";
NAME_MAP["taren peng"] = "taren";
NAME_MAP["roman"] = "roman";
NAME_MAP["roman goryachev"] = "roman";
NAME_MAP["shane"] = "shane";
NAME_MAP["shane gibson"] = "shane";

function resolvePersonId(name) {
  if (!name) return "blake";
  const lower = name.toLowerCase().trim();
  return NAME_MAP[lower] || NAME_MAP[lower.split(" ")[0]] || null;
}

function run() {
  if (!fs.existsSync(SOURCE)) {
    console.error("Source not found:", SOURCE);
    process.exit(1);
  }

  const source = JSON.parse(fs.readFileSync(SOURCE, "utf-8"));
  const discoveredPeople = new Map();

  // Seed known people
  for (const p of KNOWN_PEOPLE) {
    discoveredPeople.set(p.id, p);
  }

  // --- Migrate action items ---
  const items = (source.actionItems || []).map((ai) => {
    const ownerId = resolvePersonId(ai.owner) || "unknown";

    // Auto-discover unknown people from owner field
    if (!discoveredPeople.has(ownerId) && ownerId === "unknown") {
      const newId = ai.owner.toLowerCase().replace(/\s+/g, "-");
      discoveredPeople.set(newId, {
        id: newId,
        name: ai.owner,
        role: "",
        team: "",
        email: "",
        tags: [],
        relationships: { reports_to: null, manages: [] },
      });
    }

    // Detect related people from notes and item text
    const relatedPeople = [];
    const fullText = `${ai.item} ${ai.notes || ""}`.toLowerCase();
    for (const [name, id] of Object.entries(NAME_MAP)) {
      if (name.length > 3 && fullText.includes(name) && id !== ownerId) {
        if (!relatedPeople.includes(id)) relatedPeople.push(id);
      }
    }

    // Auto-categorize
    let category = "general";
    const text = `${ai.item} ${ai.notes || ""}`.toLowerCase();
    if (text.includes("incident") || text.includes("emergency") || text.includes("outage")) category = "incident";
    else if (text.includes("document") || text.includes("wiki") || text.includes("procedure")) category = "documentation";
    else if (text.includes("tool") || text.includes("script") || text.includes("automat") || text.includes("build")) category = "tooling";
    else if (text.includes("jira") || text.includes("ticket") || text.includes("zendesk")) category = "process";
    else if (text.includes("market") || text.includes("social media") || text.includes("linkedin")) category = "marketing";
    else if (text.includes("test") || text.includes("beta") || text.includes("qa")) category = "testing";
    else if (text.includes("train") || text.includes("setup") || text.includes("environment")) category = "setup";
    else if (text.includes("compens") || text.includes("raise") || text.includes("promot")) category = "hr";
    else if (text.includes("charter") || text.includes("metric") || text.includes("kpi")) category = "strategy";

    // Auto-prioritize
    let priority = "medium";
    if (ai.status === "overdue") priority = "high";
    else if (ai.dueDate) {
      const daysLeft = (new Date(ai.dueDate) - new Date()) / 86400000;
      if (daysLeft < 0) priority = "high";
      else if (daysLeft < 3) priority = "high";
      else if (daysLeft > 14) priority = "low";
    }

    return {
      id: ai.id,
      item: ai.item,
      ownerId: resolvePersonId(ai.owner) || "blake",
      assignedTo: [resolvePersonId(ai.owner) || "blake"],
      relatedPeople,
      dueDate: ai.dueDate,
      status: ai.status,
      priority,
      category,
      meetingTitle: ai.meetingTitle,
      meetingDate: ai.meetingDate,
      dateAdded: ai.dateAdded,
      completedDate: ai.completedDate,
      notes: ai.notes,
    };
  });

  // --- Migrate meetings → interactions ---
  const meetings = (source.meetings || []).map((m, idx) => {
    const participantIds = m.participants
      .map((name) => resolvePersonId(name))
      .filter(Boolean);

    // Find action items from this meeting
    const actionItemIds = items
      .filter((ai) => ai.meetingTitle === m.title && ai.meetingDate === m.date)
      .map((ai) => ai.id);

    return {
      id: `m${idx + 1}`,
      title: m.title,
      date: m.date,
      participantIds: [...new Set(participantIds)],
      actionItemIds,
      actionItemCount: m.actionItemCount,
      keyTopics: [],
      sentiment: null,
    };
  });

  // --- Write output files ---
  const peopleData = {
    lastUpdated: new Date().toISOString(),
    people: [...discoveredPeople.values()],
  };

  const actionItemsData = {
    lastUpdated: new Date().toISOString(),
    items,
  };

  const interactionsData = {
    lastUpdated: new Date().toISOString(),
    meetings,
  };

  fs.writeFileSync(
    path.join(DATA_DIR, "people.json"),
    JSON.stringify(peopleData, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "action-items.json"),
    JSON.stringify(actionItemsData, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "interactions.json"),
    JSON.stringify(interactionsData, null, 2) + "\n"
  );

  console.log(`Migrated:`);
  console.log(`  ${peopleData.people.length} people → people.json`);
  console.log(`  ${items.length} action items → action-items.json`);
  console.log(`  ${meetings.length} meetings → interactions.json`);
}

run();
