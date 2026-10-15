import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { type Io, run } from "../src/cli";

const encoder = new TextEncoder();

interface Harness {
  io: Io;
  out: () => string;
  err: () => string;
}

function makeIo(
  files: Record<string, string | Uint8Array>,
  stdin: string | Uint8Array = "",
): Harness {
  const map = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(files)) {
    map.set(name, typeof content === "string" ? encoder.encode(content) : content);
  }
  const stdinBytes = typeof stdin === "string" ? encoder.encode(stdin) : stdin;
  let out = "";
  let err = "";
  const io: Io = {
    readStdin() {
      return stdinBytes;
    },
    readFile(path) {
      const bytes = map.get(path);
      if (bytes === undefined) {
        throw new Error("file not found");
      }
      return bytes;
    },
    out(text) {
      out += text;
    },
    err(text) {
      err += text;
    },
  };
  return { io, out: () => out, err: () => err };
}

function parseError(args: string[]): string {
  try {
    parseArgs(args);
  } catch (error) {
    if (error instanceof UsageError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected parseArgs to reject the arguments");
}

function expectRunUsageError(args: string[], message: string): void {
  const h = makeIo({});
  expect(run(args, h.io)).toBe(2);
  expect(h.out()).toBe("");
  expect(h.err()).toBe(`stmtsplit: ${message}\n`);
}

const migrateSql = [
  "-- create the tables",
  "CREATE TABLE users (",
  "  id INTEGER PRIMARY KEY,",
  "  name TEXT NOT NULL DEFAULT 'a;b'",
  ");",
  "",
  "/* seed; two rows */",
  "INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y');",
  'SELECT "weird;name" FROM users; -- trailing',
].join("\n");

describe("--only parsing", () => {
  test("accepts both spellings among options and the file", () => {
    expect(parseArgs(["split", "--only", "2", "migrate.sql"])).toEqual({
      command: "split",
      dialect: "ansi",
      only: 2,
      file: "migrate.sql",
    });
    expect(parseArgs(["split", "migrate.sql", "--only=3"])).toEqual({
      command: "split",
      dialect: "ansi",
      only: 3,
      file: "migrate.sql",
    });
  });

  test("the last --only value wins", () => {
    expect(parseArgs(["split", "--only=3", "--only", "2", "migrate.sql"]).only).toBe(2);
    expect(parseArgs(["split", "--only", "2", "--only=3", "migrate.sql"]).only).toBe(3);
  });

  test("accepts the inclusive minimum and maximum", () => {
    expect(parseArgs(["split", "--only", "1", "migrate.sql"]).only).toBe(1);
    expect(parseArgs(["split", "--only=1000000", "migrate.sql"]).only).toBe(1_000_000);
  });

  test("rejects every malformed or out-of-range value", () => {
    for (const value of ["0", "01", "-1", "+1", "1.5", "x", "", "1000001"]) {
      const args = value === "" ? ["split", "--only="] : ["split", "--only", value, "migrate.sql"];
      expect(parseError(args)).toBe(
        `invalid --only "${value}" (expected a whole number from 1 to 1000000)`,
      );
    }
  });

  test("requires a value when --only is the final argument", () => {
    expect(parseError(["split", "--only"])).toBe("--only needs a value");
  });

  test("checks dialect validity before --only validity", () => {
    expect(parseError(["split", "--dialect", "oracle", "--only=0", "migrate.sql"])).toBe(
      'invalid --dialect "oracle"',
    );
    expect(parseError(["split", "--dialect=postgres", "--only=0", "migrate.sql"])).toBe(
      'invalid --only "0" (expected a whole number from 1 to 1000000)',
    );
  });

  test("checks the --only value before command applicability", () => {
    expect(parseError(["count", "--only", "0", "migrate.sql"])).toBe(
      'invalid --only "0" (expected a whole number from 1 to 1000000)',
    );
  });

  test("--only is only valid for count and check errors", () => {
    expect(parseError(["count", "--only", "1", "migrate.sql"])).toBe(
      "--only is only valid for split",
    );
    expect(parseError(["check", "--only=1", "migrate.sql"])).toBe("--only is only valid for split");
  });

  test("missing FILE and too many arguments are checked afterward", () => {
    expect(parseError(["split", "--only", "1"])).toBe("missing FILE");
    expect(parseError(["split", "one.sql", "--only=1", "two.sql"])).toBe("too many arguments");
  });
});

describe("--only selection", () => {
  test("prints only statement 2 with its whole-script line number", () => {
    const h = makeIo({ "migrate.sql": migrateSql });
    expect(run(["split", "--only", "2", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe(
      "-- #2 line 8\nINSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y')\n",
    );
    expect(h.err()).toBe("");
  });

  test("supports --only= after the file", () => {
    const h = makeIo({ "migrate.sql": migrateSql });
    expect(run(["split", "migrate.sql", "--only=3"], h.io)).toBe(0);
    expect(h.out()).toBe('-- #3 line 9\nSELECT "weird;name" FROM users\n');
    expect(h.err()).toBe("");
  });

  test("a repeated option selects its last value", () => {
    const h = makeIo({ "migrate.sql": migrateSql });
    expect(run(["split", "--only=3", "migrate.sql", "--only", "1"], h.io)).toBe(0);
    expect(h.out()).toBe(
      "-- #1 lines 2-5\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL DEFAULT 'a;b'\n)\n",
    );
    expect(h.err()).toBe("");
  });

  test("prints the first multi-line statement without changing its number or text", () => {
    const h = makeIo({ "migrate.sql": migrateSql });
    expect(run(["split", "--only", "1", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe(
      "-- #1 lines 2-5\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL DEFAULT 'a;b'\n)\n",
    );
    expect(h.err()).toBe("");
  });

  test("supports dialect options and standard input", () => {
    const h = makeIo({}, "SELECT $$a;b$$; SELECT 2;\n");
    expect(run(["split", "--dialect=postgres", "-", "--only", "1"], h.io)).toBe(0);
    expect(h.out()).toBe("-- #1 line 1\nSELECT $$a;b$$\n");
    expect(h.err()).toBe("");
  });

  test("selects a statement from standard input by its original number", () => {
    const h = makeIo({}, "SELECT 1;\nSELECT 2;\n");
    expect(run(["split", "-", "--only", "2"], h.io)).toBe(0);
    expect(h.out()).toBe("-- #2 line 2\nSELECT 2\n");
    expect(h.err()).toBe("");
  });

  test("reports a missing statement with a plural count", () => {
    const h = makeIo({ "migrate.sql": migrateSql });
    expect(run(["split", "--only", "4", "migrate.sql"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: migrate.sql: no statement 4 (the script has 3 statements)\n");
  });

  test("reports a missing statement with a singular count", () => {
    const h = makeIo({}, "SELECT 1;\n");
    expect(run(["split", "-", "--only=2"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: <stdin>: no statement 2 (the script has 1 statement)\n");
  });

  test("reports a missing statement when there are zero statements", () => {
    const h = makeIo({ "empty.sql": "-- only a comment\n" });
    expect(run(["split", "--only=1", "empty.sql"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: empty.sql: no statement 1 (the script has 0 statements)\n");
  });

  test("reports script problems before a missing statement", () => {
    const h = makeIo({ "bad.sql": "SELECT 'x;\n" });
    expect(run(["split", "--only", "9", "bad.sql"], h.io)).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: bad.sql:1: unterminated string\n");
  });

  test("run reports command applicability errors without reading input", () => {
    expectRunUsageError(["count", "--only", "1", "migrate.sql"], "--only is only valid for split");
    expectRunUsageError(["check", "--only=1", "migrate.sql"], "--only is only valid for split");
  });
});

describe("--only documentation", () => {
  test("README documents usage, behavior, and the selected output", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    const readme = raw.replaceAll("\r\n", "\n");
    expect(readme).toContain("usage: stmtsplit split [--dialect NAME] [--only N] FILE");
    expect(readme).toContain(
      "`--only N` (a whole number from 1 to 1000000, `split` only) prints only statement number N, with the same header; the numbers are those of the whole script.",
    );
    expect(readme).toContain(
      "`stmtsplit split --only 2 migrate.sql` prints:\n\n```\n-- #2 line 8\nINSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y')\n```",
    );
    expect(readme).toContain(
      "If the script has fewer than N statements, `stmtsplit: DISPLAY: no statement N (the script has M statements)` goes to standard error and the exit code is 2; a script with problems is reported first, as without the option.",
    );
  });
});
