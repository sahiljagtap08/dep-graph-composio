import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Phase 3: Edge resolver.
 *
 * Takes the per-tool LLM extractions (data/extracted/*.json) plus the raw tool
 * dumps and emits data/graph.json — a typed dependency graph with confidence
 * scores per edge. This is pure logic, no LLM calls.
 *
 * Edge types:
 *   - producer_consumer : tool B needs an entity that tool A produces
 *   - lookup            : tool B needs an entity that's typically resolved via
 *                         a search/list tool (the lookup tool itself is the producer)
 *   - requires_user_input : tool B has user_provided params (annotated on the node, not an edge)
 *   - mentioned         : a tool description explicitly names another slug
 *
 * Confidence (0..1):
 *   1.0 — explicit slug mention in description ("Use X to get this Y")
 *   0.8 — exact entity match + producer is a list/get/create style tool in the SAME toolkit
 *   0.6 — exact entity match + producer in different toolkit (still possible but suspicious)
 *   0.4 — fuzzy entity match (after normalization)
 */

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
  tags?: string[];
};

type Extraction = {
  produces: { entity: string; description: string }[];
  consumes: {
    param: string;
    required: boolean;
    classification:
      | "user_provided"
      | "producer_ref"
      | "lookup_required"
      | "constant_or_default";
    entity: string | null;
    rationale: string;
    mentionedProducers: string[];
  }[];
};

type Node = {
  id: string; // tool slug
  toolkit: string;
  name: string;
  description: string;
  produces: string[]; // canonical entities
  requiresUserInput: { param: string; rationale: string }[];
  category: "list" | "get" | "create" | "update" | "delete" | "action";
};

type Edge = {
  source: string; // producer slug
  target: string; // consumer slug
  entity: string;
  param: string;
  type: "producer_consumer" | "lookup" | "mentioned";
  required: boolean;
  confidence: number;
  rationale: string;
};

const TOOLS_PATHS = [
  "data/tools.googlesuper.json",
  "data/tools.github.json",
];
const EXTRACT_DIR = "data/extracted";
const OUT_PATH = "data/graph.json";

// Normalize entity names — strip toolkit prefixes, collapse synonyms.
function normalizeEntity(raw: string): string {
  let e = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  // strip leading article/qualifier
  e = e.replace(/^the_/, "");
  // common synonym collapse
  const synonyms: Record<string, string> = {
    pr_number: "pull_number",
    pull_request_number: "pull_number",
    pullrequest_number: "pull_number",
    repository: "repo",
    repository_name: "repo",
    repo_name: "repo",
    repository_owner: "owner",
    repo_owner: "owner",
    threadid: "thread_id",
    messageid: "message_id",
    fileid: "file_id",
    folderid: "folder_id",
    eventid: "event_id",
    calendarid: "calendar_id",
    spreadsheetid: "spreadsheet_id",
    sheetid: "sheet_id",
    documentid: "document_id",
    issuenumber: "issue_number",
    pullnumber: "pull_number",
    commentid: "comment_id",
    releaseid: "release_id",
    workflowid: "workflow_id",
    runid: "run_id",
    user_login_name: "user_login",
    username: "user_login",
    login: "user_login",
  };
  return synonyms[e] || e;
}

function categorize(slug: string): Node["category"] {
  const s = slug.toUpperCase();
  if (/_LIST(_|$)/.test(s) || s.endsWith("_SEARCH") || s.includes("_FETCH"))
    return "list";
  if (/_GET(_|$)/.test(s) || s.endsWith("_RETRIEVE")) return "get";
  if (s.includes("_CREATE") || s.includes("_INSERT") || s.includes("_ADD")) return "create";
  if (s.includes("_UPDATE") || s.includes("_PATCH") || s.includes("_EDIT")) return "update";
  if (s.includes("_DELETE") || s.includes("_REMOVE") || s.includes("_ARCHIVE"))
    return "delete";
  return "action";
}

async function loadRawTools(): Promise<RawTool[]> {
  const all: RawTool[] = [];
  for (const p of TOOLS_PATHS) {
    const arr = JSON.parse(await readFile(p, "utf-8")) as RawTool[];
    all.push(...arr);
  }
  return all;
}

async function loadExtractions(): Promise<Map<string, Extraction>> {
  const map = new Map<string, Extraction>();
  if (!existsSync(EXTRACT_DIR)) return map;
  const files = await readdir(EXTRACT_DIR);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const slug = f.replace(/\.json$/, "");
    try {
      const e = JSON.parse(await readFile(join(EXTRACT_DIR, f), "utf-8")) as Extraction;
      map.set(slug, e);
    } catch {
      console.warn(`failed to parse extraction: ${f}`);
    }
  }
  return map;
}

function main() {
  return (async () => {
    const rawTools = await loadRawTools();
    const extractions = await loadExtractions();
    const slugSet = new Set(rawTools.map((t) => t.slug));

    console.log(`raw tools: ${rawTools.length}, extractions: ${extractions.size}`);
    const missing = rawTools.filter((t) => !extractions.has(t.slug));
    if (missing.length > 0) {
      console.warn(`${missing.length} tools missing extractions (skipped):`);
      for (const t of missing.slice(0, 5)) console.warn(`  - ${t.slug}`);
    }

    // 1. Build node list
    const nodes: Node[] = [];
    const nodeBySlug = new Map<string, Node>();
    for (const tool of rawTools) {
      const ex = extractions.get(tool.slug);
      if (!ex) continue;
      const produced = new Set<string>(ex.produces.map((p) => normalizeEntity(p.entity)));
      const node: Node = {
        id: tool.slug,
        toolkit: tool.toolkit.slug,
        name: tool.name,
        description: tool.description,
        produces: [...produced],
        requiresUserInput: ex.consumes
          .filter((c) => c.classification === "user_provided" && c.required)
          .map((c) => ({ param: c.param, rationale: c.rationale })),
        category: categorize(tool.slug),
      };
      nodes.push(node);
      nodeBySlug.set(tool.slug, node);
    }

    // 2. Build a producer index: entity → set of producer slugs
    const producersByEntity = new Map<string, Set<string>>();
    for (const node of nodes) {
      for (const ent of node.produces) {
        let set = producersByEntity.get(ent);
        if (!set) {
          set = new Set();
          producersByEntity.set(ent, set);
        }
        set.add(node.id);
      }
    }

    // 3. Resolve edges
    const edges: Edge[] = [];
    const seenEdges = new Set<string>(); // dedupe (source, target, entity, param)

    function addEdge(e: Edge) {
      const k = `${e.source}|${e.target}|${e.entity}|${e.param}`;
      if (seenEdges.has(k)) return;
      seenEdges.add(k);
      edges.push(e);
    }

    for (const tool of rawTools) {
      const ex = extractions.get(tool.slug);
      if (!ex) continue;
      const consumer = tool.slug;
      const consumerToolkit = tool.toolkit.slug;

      for (const c of ex.consumes) {
        // (A) explicit slug mentions — high confidence
        for (const mentioned of c.mentionedProducers) {
          const mUp = mentioned.toUpperCase();
          // resolve to a real slug (the model sometimes drops the toolkit prefix)
          const candidates = [...slugSet].filter(
            (s) => s === mUp || s.endsWith(`_${mUp}`) || s.includes(mUp),
          );
          for (const producer of candidates.slice(0, 3)) {
            if (producer === consumer) continue;
            addEdge({
              source: producer,
              target: consumer,
              entity: c.entity ? normalizeEntity(c.entity) : "(mentioned)",
              param: c.param,
              type: "mentioned",
              required: c.required,
              confidence: 1.0,
              rationale: `description explicitly names ${producer}`,
            });
          }
        }

        // (B) entity-based resolution for producer_ref + lookup_required
        if (
          (c.classification === "producer_ref" || c.classification === "lookup_required") &&
          c.entity
        ) {
          const norm = normalizeEntity(c.entity);
          const producers = producersByEntity.get(norm);
          if (!producers) continue;
          for (const producerSlug of producers) {
            if (producerSlug === consumer) continue;
            const producer = nodeBySlug.get(producerSlug);
            if (!producer) continue;

            // confidence heuristic
            let confidence = 0.6;
            if (producer.toolkit === consumerToolkit) confidence = 0.8;
            // strongly prefer list/get/create as producers for producer_ref
            if (
              c.classification === "producer_ref" &&
              (producer.category === "list" || producer.category === "get" || producer.category === "create")
            ) {
              confidence = Math.min(1.0, confidence + 0.1);
            }
            // for lookup_required, prefer list/search tools
            if (c.classification === "lookup_required" && producer.category !== "list") {
              confidence -= 0.2;
            }

            addEdge({
              source: producerSlug,
              target: consumer,
              entity: norm,
              param: c.param,
              type: c.classification === "lookup_required" ? "lookup" : "producer_consumer",
              required: c.required,
              confidence: Math.max(0, Math.min(1, confidence)),
              rationale: c.rationale,
            });
          }
        }
      }
    }

    // 4. Summary stats
    const stats = {
      generatedAt: new Date().toISOString(),
      nodes: nodes.length,
      edges: edges.length,
      byToolkit: nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.toolkit] = (acc[n.toolkit] || 0) + 1;
        return acc;
      }, {}),
      byEdgeType: edges.reduce<Record<string, number>>((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      }, {}),
      topEntities: [...producersByEntity.entries()]
        .map(([entity, set]) => ({ entity, producers: set.size }))
        .sort((a, b) => b.producers - a.producers)
        .slice(0, 15),
      orphanNodes: nodes.filter(
        (n) =>
          !edges.some((e) => e.source === n.id || e.target === n.id),
      ).length,
    };

    await mkdir("data", { recursive: true });
    await writeFile(
      OUT_PATH,
      JSON.stringify({ stats, nodes, edges }, null, 2),
    );
    await writeFile(
      "data/graph.summary.json",
      JSON.stringify(stats, null, 2),
    );

    console.log("\n=== graph stats ===");
    console.log(JSON.stringify(stats, null, 2));
  })();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
