#!/usr/bin/env node
// A stand-in agent CLI for the real-engine sandbox check: it reads its prompt,
// writes a file into its workspace, tries to write outside it, and answers
// with what it found — as one line of JSON.
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const tryWrite = (path) => {
    try {
      writeFileSync(path, "x");
      return true;
    } catch {
      return false;
    }
  };
  const report = {
    prompt: prompt.trim(),
    cwd: process.cwd(),
    uid: process.getuid(),
    gid: process.getgid(),
    wroteWorkspace: tryWrite("from-container.txt"),
    wroteRoot: tryWrite("/odw-escape.txt"),
    wroteTmp: tryWrite("/tmp/scratch.txt"),
    home: process.env.HOME ?? null,
    hostPathLeaked: (process.env.PATH ?? "").includes("/home/runner"),
  };
  process.stdout.write(JSON.stringify(report));
});
