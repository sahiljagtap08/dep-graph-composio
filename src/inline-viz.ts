import { readFile, writeFile } from "node:fs/promises";

/**
 * Inlines data/graph.json directly into dep-graph.html so the file can be
 * opened by double-clicking it (file:// scheme blocks fetch() in browsers).
 *
 * This rewrites dep-graph.html in place. The template uses a marker
 *   <script id="graph-data" type="application/json">{}</script>
 * which we replace with the actual graph JSON.
 */

const HTML_PATH = "dep-graph.html";
const GRAPH_PATH = "data/graph.json";

const MARKER_OPEN = '<script id="graph-data" type="application/json">';
const MARKER_CLOSE = "</script>";

async function main() {
  let html = await readFile(HTML_PATH, "utf-8");
  const graphRaw = await readFile(GRAPH_PATH, "utf-8");
  // Sanity check: must be valid JSON.
  JSON.parse(graphRaw);

  // If the template doesn't have the marker yet, insert one right before </body>.
  if (!html.includes(MARKER_OPEN)) {
    html = html.replace(
      "</body>",
      `    ${MARKER_OPEN}{}${MARKER_CLOSE}\n  </body>`,
    );
  }

  // Replace the data inside the marker. JSON cannot break a </script> close
  // because JSON doesn't contain "</" sequences in our data, but escape just
  // in case to be safe.
  const safeJson = graphRaw.replace(/<\/script>/g, "<\\/script>");
  html = html.replace(
    new RegExp(`${MARKER_OPEN}[\\s\\S]*?${MARKER_CLOSE}`),
    `${MARKER_OPEN}${safeJson}${MARKER_CLOSE}`,
  );

  await writeFile(HTML_PATH, html);
  const sizeKB = Math.round(html.length / 1024);
  console.log(`inlined ${graphRaw.length} bytes of graph data → ${HTML_PATH} (${sizeKB} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
