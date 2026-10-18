#!/usr/bin/env node
/**
 * Fake agent CLI for the `odw eval` tests: no model, a JSON reply with usage
 * and cost, like a CLI configured with `output: { format: "json", … }`.
 *
 * The prompt steers it: `WORD <w>` replies { word, len }, `SLEEP <ms>` waits
 * that long first, `FAIL` exits 1. Its adapter name (argv[2]) is in the reply,
 * and its cost is EVAL_AGENT_COST (default 0.01).
 */

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const word = (input.match(/WORD (\w+)/) || [])[1] || "none";
  const sleep = Number((input.match(/SLEEP (\d+)/) || [])[1] || 0);
  setTimeout(() => {
    if (/\bFAIL\b/.test(input)) {
      process.stderr.write("failing on purpose\n");
      process.exit(1);
    }
    const reply = { word, len: word.length, adapter: process.argv[2] || "?" };
    const cost = Number(process.env.EVAL_AGENT_COST || 0.01);
    process.stdout.write(JSON.stringify({ text: JSON.stringify(reply), usage: { input_tokens: 100, output_tokens: 20 }, cost }));
  }, sleep);
});
