#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { type Io, run } from "./cli";

const io: Io = {
  readStdin: () => readFileSync(0),
  readFile: (path) => readFileSync(path),
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

process.exitCode = run(process.argv.slice(2), io);
