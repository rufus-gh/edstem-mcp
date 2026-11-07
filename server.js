#!/usr/bin/env node
// MCP server for Ed Discussion (edstem.org). Read-only.
// Auth: set ED_API_TOKEN (create one at https://edstem.org/us/settings/api-tokens,
// swap "us" for your region, e.g. "au").
// Optional: ED_API_BASE (default https://edstem.org/api).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.ED_API_BASE || "https://edstem.org/api").replace(/\/$/, "");
const TOKEN = process.env.ED_API_TOKEN;

async function ed(path, params = {}) {
  if (!TOKEN) throw new Error("ED_API_TOKEN is not set");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Ed API ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Ed bodies come as `document` (plain text) and `content` (XML). Prefer the former.
function text(o) {
  if (!o) return "";
  if (o.document) return o.document.trim();
  return (o.content || "")
    .replace(/<\/?(paragraph|heading|list-item|break)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const day = (s) => (s ? s.slice(0, 10) : "");

function threadHeader(t) {
  const flags = [
    t.type,
    t.is_pinned && "PINNED",
    t.is_endorsed && "endorsed",
    t.type === "question" && (t.is_answered ? "answered" : "UNANSWERED"),
    t.is_staff_answered && "staff-answered",
  ].filter(Boolean).join(", ");
  const cat = [t.category, t.subcategory].filter(Boolean).join(" > ");
  return `#${t.id} [${flags}] ${t.title}${cat ? ` (${cat})` : ""} — ${day(t.created_at)}, updated ${day(t.updated_at)}, ${t.reply_count ?? 0} replies`;
}

function renderReplies(list, users, indent = "  ") {
  let out = "";
  for (const r of list || []) {
    const u = users[r.user_id];
    const who = u ? `${u.name}${u.role && u.role !== "student" ? ` (${u.role})` : ""}` : r.is_anonymous ? "anon" : "?";
    const marks = [r.is_endorsed && "endorsed", r.is_resolved && "accepted"].filter(Boolean).join(",");
    out += `${indent}- ${who}${marks ? ` [${marks}]` : ""} ${day(r.created_at)}: ${text(r).replace(/\n/g, "\n" + indent + "  ")}\n`;
    out += renderReplies(r.comments, users, indent + "    ");
  }
  return out;
}

async function fetchThread(id) {
  const { thread, users = [] } = await ed(`/threads/${id}`, { view: 1 });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  let out = `${threadHeader(thread)}\nAuthor: ${byId[thread.user_id]?.name ?? (thread.is_anonymous ? "anon" : "?")}\n\n${text(thread)}\n`;
  if (thread.answers?.length) out += `\nANSWERS:\n${renderReplies(thread.answers, byId)}`;
  if (thread.comments?.length) out += `\nCOMMENTS:\n${renderReplies(thread.comments, byId)}`;
  return out;
}

async function listAll(courseId, { limit, sort = "new", category }) {
  const out = [];
  while (out.length < limit) {
    const page = Math.min(100, limit - out.length);
    const { threads = [] } = await ed(`/courses/${courseId}/threads`, { limit: page, offset: out.length, sort });
    out.push(...threads);
    if (threads.length < page) break;
  }
  return category ? out.filter((t) => (t.category || "").toLowerCase() === category.toLowerCase()) : out;
}

// Run `fn` over items with bounded concurrency.
async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { res[k] = await fn(items[k]); } catch (e) { res[k] = `#${items[k].id}: failed to fetch (${e.message})`; }
    }
  }));
  return res;
}

const server = new McpServer({ name: "edstem", version: "1.0.0" });
const reply = (s) => ({ content: [{ type: "text", text: s }] });

server.registerTool("list_courses", {
  description: "List the Ed courses the user is enrolled in, with course IDs.",
  inputSchema: {},
}, async () => {
  const { courses = [] } = await ed("/user");
  return reply(courses.map(({ course: c, role }) =>
    `${c.id}: ${c.code} — ${c.name} (${c.year ?? ""} ${c.session ?? ""}, role: ${role?.role ?? "?"}, status: ${c.status})`).join("\n"));
});

server.registerTool("list_threads", {
  description: "List thread titles/metadata for a course (no bodies). Use get_thread for full content.",
  inputSchema: {
    course_id: z.number(),
    limit: z.number().int().min(1).max(500).default(50),
    sort: z.enum(["new", "top", "active", "unanswered"]).default("new"),
    category: z.string().optional().describe("Only threads in this category, e.g. 'Assignments'"),
  },
}, async ({ course_id, limit, sort, category }) => {
  const ts = await listAll(course_id, { limit, sort, category });
  return reply(ts.map(threadHeader).join("\n") || "No threads.");
});

server.registerTool("get_thread", {
  description: "Get a thread's full text including answers and comments.",
  inputSchema: { thread_id: z.number() },
}, async ({ thread_id }) => reply(await fetchThread(thread_id)));

server.registerTool("get_course_digest", {
  description:
    "Fetch the full text (posts, staff answers, comments) of a course's threads in one go, so you can summarise what matters: " +
    "deadlines, extensions, assessment clarifications, errata, announcements. Announcements and pinned threads always come first. " +
    "Threads are filtered to those created or updated within `days`.",
  inputSchema: {
    course_id: z.number(),
    days: z.number().int().min(1).max(365).default(30),
    max_threads: z.number().int().min(1).max(300).default(100),
    types: z.array(z.enum(["announcement", "post", "question"])).optional().describe("Default: all types"),
  },
}, async ({ course_id, days, max_threads, types }) => {
  const cutoff = Date.now() - days * 864e5;
  // Stop paging once a full page of non-pinned threads is older than the cutoff.
  const all = [];
  for (let off = 0; all.length < 1000; off += 100) {
    const { threads = [] } = await ed(`/courses/${course_id}/threads`, { limit: 100, offset: off, sort: "new" });
    all.push(...threads);
    if (threads.length < 100) break;
    const nonPinned = threads.filter((t) => !t.is_pinned);
    if (nonPinned.length && nonPinned.every((t) => Date.parse(t.updated_at) < cutoff)) break;
  }
  let sel = all.filter((t) => t.is_pinned || t.type === "announcement" || Date.parse(t.updated_at) >= cutoff);
  if (types) sel = sel.filter((t) => types.includes(t.type));
  const rank = (t) => (t.type === "announcement" ? 0 : t.is_pinned ? 1 : 2);
  sel.sort((a, b) => rank(a) - rank(b) || Date.parse(b.created_at) - Date.parse(a.created_at));
  const total = sel.length;
  sel = sel.slice(0, max_threads);
  const bodies = await pool(sel, 6, (t) => fetchThread(t.id));
  return reply(`${total} relevant threads in the last ${days} days (showing ${sel.length}).\n\n` + bodies.join("\n\n=========\n\n"));
});

server.registerTool("search_threads", {
  description: "Search the latest 500 threads of a course by keyword (title + body); returns matching thread headers.",
  inputSchema: { course_id: z.number(), query: z.string(), limit: z.number().int().max(100).default(30) },
}, async ({ course_id, query, limit }) => {
  const q = query.toLowerCase();
  const all = await listAll(course_id, { limit: 500 });
  const hits = all.filter((t) => `${t.title} ${text(t)}`.toLowerCase().includes(q)).slice(0, limit);
  return reply(hits.map(threadHeader).join("\n") || "No matches.");
});

await server.connect(new StdioServerTransport());
