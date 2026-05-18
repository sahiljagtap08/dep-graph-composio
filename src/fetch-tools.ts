import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Composio } from "@composio/core";

const TOOLKITS = ["googlesuper", "github"] as const;
const OUT_DIR = "data";

type RawTool = Awaited<
  ReturnType<Composio["tools"]["getRawComposioTools"]>
>[number];

async function main() {
  if (!process.env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY missing — run scaffold.sh first");
  }
  await mkdir(OUT_DIR, { recursive: true });

  const composio = new Composio();
  const byToolkit: Record<string, RawTool[]> = {};
  const all: RawTool[] = [];

  for (const toolkit of TOOLKITS) {
    const tools = await composio.tools.getRawComposioTools({
      toolkits: [toolkit],
      limit: 1000,
    });
    byToolkit[toolkit] = tools;
    all.push(...tools);
    await writeFile(
      join(OUT_DIR, `tools.${toolkit}.json`),
      JSON.stringify(tools, null, 2),
      "utf-8",
    );
    console.log(`${toolkit}: ${tools.length} tools`);
  }

  await writeFile(
    join(OUT_DIR, "tools.json"),
    JSON.stringify(all, null, 2),
    "utf-8",
  );

  const summary = {
    fetchedAt: new Date().toISOString(),
    total: all.length,
    perToolkit: Object.fromEntries(
      Object.entries(byToolkit).map(([k, v]) => [k, v.length]),
    ),
    sampleSlugs: all.slice(0, 5).map((t) => t.slug),
  };
  await writeFile(
    join(OUT_DIR, "tools.summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  console.log("\nsummary:", summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
