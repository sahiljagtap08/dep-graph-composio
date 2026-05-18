import { Composio } from "@composio/core";

const composio = new Composio();

// raw tools are direct tools from composio without any wrapping based on providers
// provider wrappings are needed for executing tools
const tools = await composio.tools.getRawComposioTools({
  toolkits: ["googlesuper"],
  limit: 1000,
});

// list of all the tools you will be building a tool router on
console.log(tools);

import { writeFile } from "fs/promises";

await writeFile(
  "googlesuper_tools.json",
  JSON.stringify(tools, null, 2),
  "utf-8"
);
console.log("Tools written to googlesuper_tools.json");
