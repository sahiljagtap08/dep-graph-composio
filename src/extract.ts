import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const MODEL = process.env.EXTRACT_MODEL || "claude-haiku-4-5";
const CONCURRENCY = Number(process.env.EXTRACT_CONCURRENCY || 16);
const TOOL_LIMIT = Number(process.env.EXTRACT_LIMIT || 0);
const OUT_DIR = "data/extracted";

type JsonSchemaProp = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  $ref?: string;
  anyOf?: Array<{ type?: string }>;
};
type RawSchema = { properties?: Record<string, JsonSchemaProp>; required?: string[] };

type RawTool = {
  slug: string;
  name: string;
  description: string;
  inputParameters: RawSchema;
  outputParameters: RawSchema;
  toolkit: { slug: string; name?: string };
};

const ExtractionSchema = z.object({
  produces: z
    .array(
      z.object({
        entity: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
  consumes: z
    .array(
      z.object({
        param: z.string(),
        required: z.boolean(),
        classification: z.enum([
          "user_provided",
          "producer_ref",
          "lookup_required",
          "constant_or_default",
        ]),
        entity: z.string().nullable(),
        rationale: z.string(),
        mentionedProducers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You analyze a single Composio tool schema and produce a strict JSON object describing its data dependencies.

The goal is to build a dependency graph between tools, so that an agent can answer: "before I can call tool X, what other tools must have run, or what info must come from the user?"

For each tool, you must answer:

1. produces — what canonical entities (IDs / references / values) does this tool's OUTPUT yield that some downstream tool might need? Use snake_case canonical names that are reusable across tools, normalized to the same identity across Gmail/Calendar/Drive/Sheets/Docs/GitHub. Examples:
   - "thread_id", "message_id", "label_id", "draft_id" (Gmail)
   - "event_id", "calendar_id" (Calendar)
   - "file_id", "folder_id" (Drive)
   - "spreadsheet_id", "sheet_id", "range" (Sheets)
   - "document_id" (Docs)
   - "owner", "repo", "issue_number", "pull_number", "branch", "sha", "ref", "comment_id", "release_id", "workflow_id", "run_id", "user_login", "team_slug", "gist_id" (GitHub)
   - "contact_email", "user_email" (lookups)

   If a list/search tool returns items containing these IDs, ALWAYS include them in produces. Be generous here — anything an ID-yielding response contains is a produced entity.

2. consumes — for EVERY input parameter (required AND optional), classify into one of:
   - "user_provided": semantic content only a human can naturally give (subject, body, query text, filters, page-size, boolean flags)
   - "producer_ref": an ID / reference / token another tool MUST produce first (thread_id, pull_number, file_id, owner+repo pair, sha, etc.)
   - "lookup_required": user names a thing in natural language and you must resolve it via a search/list/get tool (a recipient by NAME → email via contacts; a repo by description; a label by name)
   - "constant_or_default": has a sensible default that works without input (e.g. user_id="me", per_page=30, time_zone="UTC")

   For producer_ref / lookup_required, fill "entity" with the canonical snake_case name. Otherwise entity is null.

   mentionedProducers: if the param description or tool description EXPLICITLY names another tool slug (UPPER_SNAKE_CASE, 5+ chars), include those slugs verbatim. Empty array if none.

Critical rules:
- Normalize entity names across toolkits — owner+repo for GitHub are paired but each is its own entity ("owner", "repo").
- Be generous with produces: any list/get/create tool exposes the IDs inside its results.
- Classifications should reflect REAL agent workflows, not strict schema reading. E.g., a recipient_email is typically lookup_required (user said "John") even though it's just a string field.
- Output ONLY the JSON object. No prose, no markdown fences.`;

function buildUserPrompt(tool: RawTool): string {
  const inputs = tool.inputParameters?.properties || {};
  const required = new Set(tool.inputParameters?.required || []);
  const compactInputs = Object.entries(inputs).map(([name, schema]) => ({
    name,
    type: schema?.type || schema?.anyOf?.[0]?.type || "unknown",
    required: required.has(name),
    default: schema?.default,
    description: schema?.description || "",
  }));

  const out = tool.outputParameters?.properties || {};
  const outputSummary = Object.entries(out)
    .map(([k, v]) => `${k}: ${v?.description || v?.title || v?.$ref || v?.type || ""}`)
    .join("\n");

  return `slug: ${tool.slug}
toolkit: ${tool.toolkit?.slug || "unknown"}
name: ${tool.name}
description: ${tool.description}

INPUT PARAMETERS:
${JSON.stringify(compactInputs, null, 2)}

OUTPUT (top-level shape):
${outputSummary || "(none)"}

Return ONLY a JSON object matching this shape:
{"produces":[{"entity":"...","description":"..."}],"consumes":[{"param":"...","required":true,"classification":"...","entity":"..."|null,"rationale":"...","mentionedProducers":["..."]}]}`;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

async function callLLM(client: Anthropic, tool: RawTool, attempt = 0): Promise<Extraction> {
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(tool) }],
    });
    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("no text in response");
    const parsed = JSON.parse(stripFences(textBlock.text));
    return ExtractionSchema.parse(parsed);
  } catch (e) {
    if (attempt < 2) {
      const wait = 500 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      return callLLM(client, tool, attempt + 1);
    }
    throw e;
  }
}

async function loadTools(): Promise<RawTool[]> {
  const a = JSON.parse(await readFile("data/tools.googlesuper.json", "utf-8"));
  const b = JSON.parse(await readFile("data/tools.github.json", "utf-8"));
  return [...a, ...b];
}

async function listDone(): Promise<Set<string>> {
  if (!existsSync(OUT_DIR)) return new Set();
  const files = await readdir(OUT_DIR);
  return new Set(files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
}

async function pool<T>(items: T[], n: number, worker: (t: T, i: number) => Promise<void>) {
  let i = 0;
  let done = 0;
  let failed = 0;
  const total = items.length;
  const start = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) break;
        const item = items[idx];
        if (!item) break;
        try {
          await worker(item, idx);
        } catch (e) {
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[${idx}] failed: ${msg.slice(0, 120)}`);
        }
        done++;
        if (done % 50 === 0 || done === total) {
          const elapsed = (Date.now() - start) / 1000;
          const rate = done / elapsed;
          const eta = Math.round((total - done) / rate);
          console.log(`  ${done}/${total} (${rate.toFixed(1)}/s, eta ${eta}s, failed=${failed})`);
        }
      }
    }),
  );
  return failed;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  await mkdir(OUT_DIR, { recursive: true });

  const all = await loadTools();
  const tools = TOOL_LIMIT > 0 ? all.slice(0, TOOL_LIMIT) : all;
  const done = await listDone();
  const todo = tools.filter((t) => !done.has(t.slug));

  console.log(`tools total=${tools.length} already_done=${done.size} todo=${todo.length}`);
  console.log(`model=${MODEL} concurrency=${CONCURRENCY}`);
  if (todo.length === 0) {
    console.log("nothing to do");
    return;
  }

  const client = new Anthropic();
  const start = Date.now();
  const failed = await pool(todo, CONCURRENCY, async (tool) => {
    const out = await callLLM(client, tool);
    await writeFile(join(OUT_DIR, `${tool.slug}.json`), JSON.stringify(out, null, 2));
  });

  console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s (failed=${failed})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
