#!/usr/bin/env node
/**
 * sync.js — Auto-detect new Granola meetings, extract action items from
 * AI panel content, merge into ts-dashboard data files, and push to GitHub.
 *
 * Outputs to dashboard/data/action-items.json and dashboard/data/interactions.json
 *
 * Runs on a schedule via Windows Task Scheduler.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DATA = path.join(__dirname, "..", "dashboard", "data");
const ITEMS_FILE = path.join(DASHBOARD_DATA, "action-items.json");
const INTERACTIONS_FILE = path.join(DASHBOARD_DATA, "interactions.json");
const PEOPLE_FILE = path.join(DASHBOARD_DATA, "people.json");
const STATE_FILE = path.join(__dirname, ".sync-state.json");
const REPO_ROOT = path.join(__dirname, "..");
const CACHE_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming"),
  "Granola",
  "cache-v3.json"
);

// --- Name → ID mapping ---
const NAME_MAP = {
  blake: "blake", "blake corbit": "blake",
  brien: "brien", "brien nunn": "brien", nun: "brien",
  jake: "jake", jacob: "jake", "jacob ryder": "jake",
  cory: "cory", "cory berg": "cory",
  ally: "ally", "ally prach": "ally",
  jenna: "jenna", "jenna treat": "jenna",
  jennifer: "jennifer",
  // Engineering team
  "alex troy": "alex_troy",
  "alex yatsenko": "alex_y",
  alexey: "alexey", "alexey polovinka": "alexey",
  anatoliy: "anatoliy", "anatoliy shapoval": "anatoliy", shweps: "anatoliy",
  dmitriy: "dmitriy", "dmitriy karlov": "dmitriy",
  marsel: "marsel", "marsel fattakhov": "marsel",
  michael: "michael_k", "michael krits": "michael_k",
  oleg: "oleg", "oleg rylin": "oleg",
  sergey: "sergey", "sergey doroshchenko": "sergey",
  slav: "slav", "slav rilov": "slav",
  ute: "ute", "ute gerlach": "ute",
  vadim: "vadim", "vadim loboda": "vadim",
  jenn: "jenn_t", "jenn thronson": "jenn_t",
  taren: "taren", "taren peng": "taren",
  roman: "roman", "roman goryachev": "roman",
  shane: "shane", "shane gibson": "shane",
  // Aliases
  cole: "cole", robert: "robert", al: "al",
};

function resolvePersonId(name) {
  if (!name) return "blake";
  const lower = name.toLowerCase().trim();
  return NAME_MAP[lower] || NAME_MAP[lower.split(" ")[0]] || "blake";
}

// --- Helpers ---

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

function loadGranolaState() {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error("Granola cache not found at " + CACHE_PATH);
  }
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  return JSON.parse(raw.cache).state;
}

function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function saveJSON(filepath, data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + "\n");
}

function loadSyncState() {
  if (!fs.existsSync(STATE_FILE)) return { processedMeetings: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function saveSyncState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function getAttendeeNames(doc) {
  const names = [];
  if (doc.people?.creator?.name) names.push(doc.people.creator.name);
  if (doc.people?.attendees) {
    for (const a of doc.people.attendees) {
      names.push(a.details?.person?.name?.fullName || a.email || "Unknown");
    }
  }
  return [...new Set(names)];
}

function nextId(items) {
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.id || 0)) + 1;
}

function categorize(text) {
  const t = text.toLowerCase();
  if (t.includes("incident") || t.includes("emergency") || t.includes("outage")) return "incident";
  if (t.includes("document") || t.includes("wiki") || t.includes("procedure")) return "documentation";
  if (t.includes("tool") || t.includes("script") || t.includes("automat") || t.includes("build")) return "tooling";
  if (t.includes("jira") || t.includes("ticket") || t.includes("zendesk")) return "process";
  if (t.includes("market") || t.includes("social media")) return "marketing";
  if (t.includes("test") || t.includes("beta")) return "testing";
  if (t.includes("train") || t.includes("setup")) return "setup";
  return "general";
}

// --- Action Item Extraction ---

function extractActionItems(panelText, meetingTitle, meetingDate, attendees) {
  const items = [];
  const lines = panelText.split("\n");

  let inActionSection = false;
  let currentOwner = null;

  const sectionPatterns = [
    /^next\s*steps/i,
    /^action\s*items/i,
    /^follow[- ]?ups?/i,
    /^to[- ]?do/i,
    /^tasks?\s*:/i,
    /^deliverables/i,
  ];

  const endPatterns = [
    /^chat with meeting transcript/i,
    /^#{1,3}\s/,
    /^[A-Z][a-z]+ [A-Z][a-z]+ &/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (sectionPatterns.some((p) => p.test(line))) {
      inActionSection = true;
      continue;
    }

    if (endPatterns.some((p) => p.test(line)) && inActionSection) {
      inActionSection = false;
      continue;
    }

    const ownerMatch = line.match(/^(\w+(?:\s\w+)?)\s*:/);
    if (ownerMatch && inActionSection) {
      currentOwner = ownerMatch[1];
      const rest = line.slice(ownerMatch[0].length).trim();
      if (rest) {
        items.push({ item: rest, owner: currentOwner });
      }
      continue;
    }

    if (inActionSection && line.length > 10) {
      let owner = "Blake";
      for (const name of attendees) {
        const firstName = name.split(" ")[0];
        if (
          line.toLowerCase().includes(firstName.toLowerCase() + " to ") ||
          line.toLowerCase().includes(firstName.toLowerCase() + " will ") ||
          line.toLowerCase().startsWith(firstName.toLowerCase())
        ) {
          owner = name;
          break;
        }
      }
      items.push({
        item: line.replace(/^[-*•]\s*/, ""),
        owner: currentOwner || owner,
      });
    }

    if (!inActionSection) {
      const actionPatterns = [
        /(?:Blake|Jacob|Brien|Cole|Cory|Ally|Jenna|Jennifer|Al|Alex|Alexey|Anatoliy|Dmitriy|Marsel|Michael|Oleg|Sergey|Slav|Ute|Vadim|Jenn|Taren|Roman|Shane)\s+(?:to|will|should|needs? to)\s+(.+)/i,
      ];
      for (const pattern of actionPatterns) {
        const match = line.match(pattern);
        if (match) {
          const ownerName = line.match(/^(\w+(?:\s\w+)?)\s+(?:to|will|should|needs? to)/i);
          items.push({
            item: match[0],
            owner: ownerName ? ownerName[1] : "Blake",
          });
        }
      }
    }
  }

  const seen = new Set();
  return items.filter((item) => {
    const key = item.item.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Main ---

function run() {
  log("Starting sync...");

  let granolaState;
  try {
    granolaState = loadGranolaState();
  } catch (e) {
    log("ERROR: " + e.message);
    return;
  }

  const itemsData = loadJSON(ITEMS_FILE);
  const interactionsData = loadJSON(INTERACTIONS_FILE);
  const syncState = loadSyncState();
  const processedSet = new Set(syncState.processedMeetings);

  const docs = granolaState.documents || {};
  const panels = granolaState.documentPanels || {};

  const newMeetings = Object.entries(docs)
    .map(([id, doc]) => ({ id, ...doc }))
    .filter((m) => !m.deleted_at)
    .filter((m) => !processedSet.has(m.id))
    .filter((m) => panels[m.id] && Object.keys(panels[m.id]).length > 0)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (newMeetings.length === 0) {
    log("No new meetings to process.");
    return;
  }

  log(`Found ${newMeetings.length} new meeting(s) to process.`);

  let totalNewItems = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const meeting of newMeetings) {
    const meetingDate = new Date(meeting.created_at).toISOString().slice(0, 10);
    const attendees = getAttendeeNames(meeting);
    const title = meeting.title || "Untitled";

    log(`Processing: "${title}" (${meetingDate})`);

    const docPanels = panels[meeting.id];
    const panelText = Object.values(docPanels)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((p) => {
        const t = p.title || "";
        const c = stripHtml(p.original_content || "");
        return t + ":\n" + c;
      })
      .join("\n\n");

    const extracted = extractActionItems(panelText, title, meetingDate, attendees);

    if (extracted.length > 0) {
      log(`  Extracted ${extracted.length} action item(s)`);
      for (const ai of extracted) {
        const ownerId = resolvePersonId(ai.owner);
        const newItem = {
          id: nextId(itemsData.items),
          item: ai.item,
          ownerId,
          assignedTo: [ownerId],
          relatedPeople: [],
          dueDate: null,
          status: "open",
          priority: "medium",
          category: categorize(ai.item),
          meetingTitle: title,
          meetingDate,
          dateAdded: today,
          completedDate: null,
          notes: "",
        };
        itemsData.items.push(newItem);
        totalNewItems++;
        log(`  + #${newItem.id}: ${ai.item.slice(0, 60)}...`);
      }
    } else {
      log(`  No action items found in panel content.`);
    }

    // Log the meeting to interactions
    const meetingId = `m${interactionsData.meetings.length + 1}`;
    if (!interactionsData.meetings.find((m) => m.title === title && m.date === meetingDate)) {
      interactionsData.meetings.push({
        id: meetingId,
        title,
        date: meetingDate,
        participantIds: [...new Set(attendees.map((n) => resolvePersonId(n)))],
        actionItemIds: extracted.length > 0
          ? itemsData.items.slice(-extracted.length).map((i) => i.id)
          : [],
        actionItemCount: extracted.length,
        keyTopics: [],
        sentiment: null,
      });
    }

    processedSet.add(meeting.id);
  }

  // Save
  syncState.processedMeetings = [...processedSet];
  saveSyncState(syncState);
  saveJSON(ITEMS_FILE, itemsData);
  saveJSON(INTERACTIONS_FILE, interactionsData);
  log(`Saved ${totalNewItems} new action item(s), ${newMeetings.length} meeting(s) logged.`);

  // Git push
  if (totalNewItems > 0 || newMeetings.length > 0) {
    try {
      execSync("git add dashboard/data/action-items.json dashboard/data/interactions.json", {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
      execSync(
        `git commit -m "Auto-sync: ${newMeetings.length} meeting(s), ${totalNewItems} action item(s)"`,
        { cwd: REPO_ROOT, stdio: "pipe" }
      );
      execSync("git push", { cwd: REPO_ROOT, stdio: "pipe" });
      log("Pushed to GitHub. Dashboard will update shortly.");
    } catch (e) {
      if (e.stderr && e.stderr.toString().includes("nothing to commit")) {
        log("No changes to commit.");
      } else {
        log("Git push failed: " + (e.stderr ? e.stderr.toString() : e.message));
      }
    }
  }

  log("Sync complete.");
}

run();
