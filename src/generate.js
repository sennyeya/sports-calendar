import fs from "node:fs/promises";
import path from "node:path";
import ical from "ical-generator";

const PANDASCORE_API = "https://api.pandascore.co/csgo/matches";
const FOOTBALL_API = "https://api.football-data.org/v4";
const MAX_PAGES = 10;

const CS2_ALIASES = {
  falcons: ["falcons", "team falcons"],
  spirit: ["spirit", "team spirit"],
  vitality: ["vitality", "team vitality"],
};
const CS2_NAMES = { falcons: "Falcons", spirit: "Team Spirit", vitality: "Vitality" };

const SOCCER_ALIASES = {
  everton: ["everton", "everton fc"],
  brighton: ["brighton & hove albion", "brighton & hove albion fc", "brighton"],
  "manchester-united": ["manchester united", "manchester united fc", "man united"],
  bayern: ["fc bayern münchen", "bayern münchen", "bayern munich", "fc bayern munich"],
  england: ["england"],
  norway: ["norway"],
};
const SOCCER_NAMES = {
  everton: "Everton",
  brighton: "Brighton",
  "manchester-united": "Manchester United",
  bayern: "Bayern Munich",
  england: "England",
  norway: "Norway",
};
const SOCCER_COMPETITIONS = ["PL", "BL1", "CL", "UNL"];
const ARCHIVE_PATH = path.resolve("data/archive.json");

function clean(v) { return String(v ?? "").replace(/\s+/g, " ").trim(); }
function normalize(v) { return clean(v).toLowerCase(); }
function cs2Opponents(m) { return (m.opponents ?? []).map(x => x.opponent).filter(Boolean); }

function cs2Slug(team) {
  const values = [team?.name, team?.acronym, team?.slug].filter(Boolean).map(normalize);
  return Object.entries(CS2_ALIASES).find(([, aliases]) => aliases.some(a => values.includes(a)))?.[0];
}
function soccerSlug(team) {
  const value = normalize(team?.name);
  return Object.entries(SOCCER_ALIASES).find(([, aliases]) => aliases.includes(value))?.[0];
}

function cs2Event(match) {
  const teams = cs2Opponents(match);
  if (teams.length !== 2 || !match.begin_at) return null;
  const start = new Date(match.begin_at);
  if (Number.isNaN(start.getTime())) return null;
  const parsedEnd = match.end_at ? new Date(match.end_at) : null;
  return {
    id: `pandascore-${match.id}@sports-calendar`,
    start,
    end: parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : new Date(start.getTime() + 3 * 3600000),
    summary: `🎮 ${clean(teams[0].name)} vs ${clean(teams[1].name)}`,
    description: [match.league?.name, match.serie?.full_name || match.serie?.name, match.tournament?.name].map(clean).filter(Boolean).join(" · "),
    url: match.official_stream_url || undefined,
  };
}

function soccerEvent(match) {
  if (!match.utcDate || !match.homeTeam?.name || !match.awayTeam?.name) return null;
  const start = new Date(match.utcDate);
  if (Number.isNaN(start.getTime())) return null;
  return {
    id: `football-data-${match.id}@sports-calendar`,
    start,
    end: new Date(start.getTime() + 2 * 3600000),
    summary: `⚽ ${clean(match.homeTeam.name)} vs ${clean(match.awayTeam.name)}`,
    description: clean(match.competition?.name),
  };
}

function calendarString(name, events) {
  const calendar = ical({
    name,
    prodId: { company: "sports-calendar", product: "Personal sports calendar" },
    timezone: "UTC",
  });
  for (const event of events) if (event) calendar.createEvent(event);
  return calendar.toString();
}

async function fetchCs2() {
  const token = process.env.PANDASCORE_API_KEY;
  if (!token) throw new Error("PANDASCORE_API_KEY is not set");
  const matches = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(PANDASCORE_API);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "-begin_at");
    url.searchParams.set("filter[status]", "finished,not_started,running");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "sports-calendar/1.0" } });
    if (!response.ok) throw new Error(`PandaScore HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const pageMatches = await response.json();
    if (!Array.isArray(pageMatches)) throw new Error("Unexpected PandaScore response");
    matches.push(...pageMatches);
    const link = response.headers.get("link") ?? "";
    if (!link.includes('rel="next"')) break;
  }
  return matches;
}

async function fetchSoccer() {
  const token = process.env.FOOTBALL_DATA_API_KEY;
  if (!token) {
    console.log("FOOTBALL_DATA_API_KEY not set; soccer feeds will be empty until it is added.");
    return [];
  }
  const byId = new Map();
  for (const competition of SOCCER_COMPETITIONS) {
    const url = `${FOOTBALL_API}/competitions/${competition}/matches`;
    const response = await fetch(url, { headers: { "X-Auth-Token": token, Accept: "application/json" } });
    if (!response.ok) throw new Error(`football-data.org ${competition} HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const data = await response.json();
    for (const match of data.matches ?? []) byId.set(match.id, match);
  }
  return [...byId.values()];
}

async function loadArchive() {
  try { return JSON.parse(await fs.readFile(ARCHIVE_PATH, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

async function main() {
  const [cs2Matches, soccerMatches, archive] = await Promise.all([fetchCs2(), fetchSoccer(), loadArchive()]);

  const cs2Relevant = cs2Matches.filter(m => cs2Opponents(m).map(cs2Slug).some(Boolean));
  const soccerRelevant = soccerMatches.filter(m => [soccerSlug(m.homeTeam), soccerSlug(m.awayTeam)].some(Boolean));

  await fs.mkdir(path.resolve("public/cs2"), { recursive: true });
  await fs.mkdir(path.resolve("public/soccer"), { recursive: true });

  for (const slug of Object.keys(CS2_NAMES)) {
    const events = cs2Relevant.filter(m => cs2Opponents(m).map(cs2Slug).includes(slug)).map(cs2Event);
    await fs.writeFile(path.resolve(`public/cs2/${slug}.ics`), calendarString(`CS2 — ${CS2_NAMES[slug]}`, events));
  }
  await fs.writeFile(path.resolve("public/cs2/falcons-spirit.ics"), calendarString("CS2 — Falcons + Team Spirit", cs2Relevant.filter(m => cs2Opponents(m).map(cs2Slug).some(slug => slug === "falcons" || slug === "spirit")).map(cs2Event)));

  for (const slug of Object.keys(SOCCER_NAMES)) {
    const events = soccerRelevant.filter(m => [soccerSlug(m.homeTeam), soccerSlug(m.awayTeam)].includes(slug)).map(soccerEvent);
    await fs.writeFile(path.resolve(`public/soccer/${slug}.ics`), calendarString(`Soccer — ${SOCCER_NAMES[slug]}`, events));
  }

  const discovered = [...cs2Relevant.map(cs2Event), ...soccerRelevant.map(soccerEvent)].filter(Boolean);
  for (const event of discovered) archive[event.id] = { ...event, start: event.start.toISOString(), end: event.end.toISOString() };
  await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(archive, null, 2) + "\n");
  const allEvents = Object.values(archive).map(event => ({ ...event, start: new Date(event.start), end: new Date(event.end) })).sort((a, b) => a.start - b.start);
  await fs.writeFile(path.resolve("public/all.ics"), calendarString("Sports", allEvents));

  const generated = new Date().toISOString();
  const links = [
    ["all.ics", "Everything"],
    ["cs2/falcons.ics", "Falcons"],
    ["cs2/spirit.ics", "Team Spirit"],
    ["cs2/vitality.ics", "Vitality"],
    ["soccer/everton.ics", "Everton"],
    ["soccer/brighton.ics", "Brighton"],
    ["soccer/manchester-united.ics", "Manchester United"],
    ["soccer/bayern.ics", "Bayern Munich"],
    ["soccer/england.ics", "England"],
    ["soccer/norway.ics", "Norway"],
  ].map(([href, label]) => `<a href="${href}">${label}</a>`).join("");
  await fs.writeFile(path.resolve("public/index.html"),
    `<!doctype html><meta charset="utf-8"><title>Sports Calendar</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5}a{display:block;margin:.8rem 0}</style><h1>Sports Calendar</h1><p>Spoiler-free schedules for the teams you follow.</p>${links}<small>Last generated: ${generated}</small>`);

  const cs2Counts = Object.keys(CS2_NAMES).map(slug => `${CS2_NAMES[slug]}: ${cs2Relevant.filter(m => cs2Opponents(m).map(cs2Slug).includes(slug)).length}`);
  const soccerCounts = Object.keys(SOCCER_NAMES).map(slug => `${SOCCER_NAMES[slug]}: ${soccerRelevant.filter(m => [soccerSlug(m.homeTeam), soccerSlug(m.awayTeam)].includes(slug)).length}`);
  console.log(`CS2: ${cs2Counts.join(" | ")}`);
  console.log(`Soccer: ${soccerCounts.join(" | ")}`);
  console.log(`Unified feed: ${allEvents.length} upcoming events`);
}

main().catch(error => { console.error(error); process.exit(1); });
