import { readFile } from "node:fs/promises";

/**
 * Evals — hand-curated "ground truth" dependencies. For each tool we list the
 * upstream producers we EXPECT the graph to contain. We check coverage in two
 * modes:
 *
 *  - producer-coverage: at least one of the expected producers shows up in the
 *    consumer's incoming edges (any edge type). This is the loose check —
 *    "did we find SOMETHING reasonable?"
 *
 *  - exact-coverage: ALL expected producers appear. This is the strict check.
 *
 * The "needsUserInput" field checks that we correctly flagged what a human has
 * to type vs. what comes from another tool.
 */

type GroundTruth = {
  consumer: string;
  // expected upstream producers (any one is a hit for producer-coverage)
  // pipe means "any of these is acceptable" (synonyms)
  producers: string[][];
  // params we expect to be flagged as user-provided on the consumer node
  needsUserInput?: string[];
  note: string;
};

const GROUND_TRUTH: GroundTruth[] = [
  {
    consumer: "GOOGLESUPER_REPLY_TO_THREAD",
    producers: [
      [
        "GOOGLESUPER_LIST_THREADS",
        "GOOGLESUPER_FETCH_EMAILS",
        "GOOGLESUPER_FETCH_MESSAGE_BY_THREAD_ID",
        "GOOGLESUPER_LIST_MESSAGES",
      ],
    ],
    needsUserInput: ["message_body", "is_html"],
    note: "Reply needs a thread_id from one of the list/fetch tools",
  },
  {
    consumer: "GOOGLESUPER_SEND_EMAIL",
    producers: [
      [
        "GOOGLESUPER_GET_CONTACTS",
        "GOOGLESUPER_SEARCH_PEOPLE",
        "GOOGLESUPER_GET_PEOPLE",
        "GOOGLESUPER_LIST_CONTACTS",
      ],
    ],
    needsUserInput: ["subject", "body"],
    note: "Sending email by name → contacts lookup",
  },
  {
    consumer: "GOOGLESUPER_ADD_LABEL_TO_EMAIL",
    producers: [
      [
        "GOOGLESUPER_LIST_THREADS",
        "GOOGLESUPER_FETCH_EMAILS",
        "GOOGLESUPER_LIST_MESSAGES",
      ],
      [
        "GOOGLESUPER_LIST_LABELS",
        "GOOGLESUPER_GET_LABEL",
        "GOOGLESUPER_LISTLABELS",
      ],
    ],
    note: "Labelling needs a message_id (from list) AND a label_id (from list labels)",
  },
  {
    consumer: "GITHUB_CREATE_AN_ISSUE_COMMENT",
    producers: [
      [
        "GITHUB_LIST_REPOSITORY_ISSUES",
        "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER",
        "GITHUB_GET_AN_ISSUE",
      ],
    ],
    needsUserInput: ["body", "repo", "owner"],
    note: "Commenting on an issue needs issue_number; body+repo+owner are user-provided",
  },
  {
    consumer: "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST",
    producers: [
      [
        "GITHUB_LIST_PULL_REQUESTS",
        "GITHUB_GET_A_PULL_REQUEST",
      ],
    ],
    needsUserInput: ["body", "repo", "owner"],
    note: "Reviewing a PR needs pull_number from list/get pulls",
  },
  {
    consumer: "GITHUB_GET_A_COMMIT",
    producers: [
      [
        "GITHUB_LIST_COMMITS",
      ],
    ],
    needsUserInput: ["repo", "owner"],
    note: "Get-commit needs a SHA (or ref) typically from list commits",
  },
  {
    consumer: "GOOGLESUPER_DELETE_EVENT",
    producers: [
      [
        "GOOGLESUPER_LIST_EVENTS",
        "GOOGLESUPER_FIND_EVENT",
        "GOOGLESUPER_GET_EVENT",
      ],
    ],
    note: "Delete-event needs event_id from list/find/get",
  },
  {
    consumer: "GOOGLESUPER_DOWNLOAD_FILE",
    producers: [
      [
        "GOOGLESUPER_FIND_FILE",
        "GOOGLESUPER_LIST_FILES",
        "GOOGLESUPER_GET_FILE_METADATA",
      ],
    ],
    note: "Download needs file_id from find/list/get-metadata",
  },
];

type Graph = {
  stats: { nodes: number; edges: number };
  nodes: {
    id: string;
    requiresUserInput: { param: string; rationale: string }[];
  }[];
  edges: {
    source: string;
    target: string;
    entity: string;
    confidence: number;
    type: string;
  }[];
};

async function main() {
  const graph: Graph = JSON.parse(await readFile("data/graph.json", "utf-8"));
  const slugSet = new Set(graph.nodes.map((n) => n.id));

  // Index incoming edges per consumer
  const incoming = new Map<string, Graph["edges"]>();
  for (const e of graph.edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }

  let hits = 0;
  let groupsTotal = 0;
  let inputHits = 0;
  let inputExpected = 0;
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const gt of GROUND_TRUTH) {
    if (!slugSet.has(gt.consumer)) {
      warnings.push(`(skip) consumer ${gt.consumer} not in graph`);
      continue;
    }
    const upstream = new Set((incoming.get(gt.consumer) || []).map((e) => e.source));
    const consumer = graph.nodes.find((n) => n.id === gt.consumer)!;
    const userInputParams = new Set(consumer.requiresUserInput.map((r) => r.param));

    console.log(`\n→ ${gt.consumer}`);
    console.log(`  ${gt.note}`);

    // producer-coverage per group
    for (const group of gt.producers) {
      groupsTotal++;
      const present = group.filter((p) => upstream.has(p));
      if (present.length > 0) {
        hits++;
        console.log(`  ✓ found producer ${present[0]} (group: ${group.join(" | ")})`);
      } else {
        const example = group[0];
        // is the expected tool even in the corpus?
        const inCorpus = group.some((p) => slugSet.has(p));
        failures.push(
          `${gt.consumer}: expected one of {${group.join(", ")}} as producer — none found${
            inCorpus ? "" : " (group has NO slugs in corpus, eval may be stale)"
          }`,
        );
        console.log(
          `  ✗ MISSING producer ${example}${inCorpus ? "" : " (group not in corpus)"}`,
        );
      }
    }

    // user-input checks
    if (gt.needsUserInput) {
      for (const p of gt.needsUserInput) {
        inputExpected++;
        if (userInputParams.has(p)) {
          inputHits++;
          console.log(`  ✓ correctly flagged "${p}" as user-provided`);
        } else {
          console.log(`  ✗ MISSED "${p}" as user-provided (have: ${[...userInputParams].join(",") || "none"})`);
        }
      }
    }
  }

  const producerRecall = hits / groupsTotal;
  const inputRecall = inputExpected > 0 ? inputHits / inputExpected : 1;

  console.log("\n=== summary ===");
  console.log(`producer-group recall: ${hits}/${groupsTotal} = ${(producerRecall * 100).toFixed(1)}%`);
  console.log(`user-input recall:     ${inputHits}/${inputExpected} = ${(inputRecall * 100).toFixed(1)}%`);
  if (warnings.length) {
    console.log("\nwarnings:");
    for (const w of warnings) console.log("  -", w);
  }
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log("  -", f);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
