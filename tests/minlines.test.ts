import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "../src/args";
import { type Io, run } from "../src/cli";

const encoder = new TextEncoder();

function makeIo(files: Record<string, string>): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  const io: Io = {
    readStdin() {
      return new Uint8Array();
    },
    readFile(path) {
      const text = files[path];
      if (text === undefined) {
        throw new Error("file not found");
      }
      return encoder.encode(text);
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

const script = [
  "-- create the tables",
  "CREATE TABLE users (",
  "  id INTEGER PRIMARY KEY,",
  "  name TEXT NOT NULL DEFAULT 'a;b'",
  ");",
  "",
  "/* seed; two rows */",
  "INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y');",
  'SELECT "weird;name" FROM users; -- trailing',
  "SELECT",
  "  1,",
  "  2;",
].join("\n");

const files = { "migrate.sql": script };

describe("--min-lines parsing", () => {
  test("accepts both spellings and keeps the last value", () => {
    expect(parseArgs(["split", "--min-lines", "2", "a.sql"]).minLines).toBe(2);
    expect(parseArgs(["count", "a.sql", "--min-lines=3"]).minLines).toBe(3);
    expect(parseArgs(["split", "--min-lines=3", "--min-lines", "4", "a.sql"]).minLines).toBe(4);
  });

  test("leaves the field out when the option is absent", () => {
    expect("minLines" in parseArgs(["split", "a.sql"])).toBe(false);
  });

  test("accepts the inclusive minimum and maximum", () => {
    expect(parseArgs(["count", "--min-lines", "1", "a.sql"]).minLines).toBe(1);
    expect(parseArgs(["count", "--min-lines=1000000", "a.sql"]).minLines).toBe(1_000_000);
  });

  test("rejects every malformed or out-of-range value", () => {
    for (const value of ["0", "01", "-1", "+1", "1.5", "x", "", "1000001"]) {
      const args =
        value === "" ? ["split", "--min-lines="] : ["split", "--min-lines", value, "a.sql"];
      expect(parseError(args)).toBe(
        `invalid --min-lines "${value}" (expected a whole number from 1 to 1000000)`,
      );
    }
  });

  test("needs a value", () => {
    expect(parseError(["split", "a.sql", "--min-lines"])).toBe("--min-lines needs a value");
  });

  test("is not valid for check", () => {
    expect(parseError(["check", "--min-lines", "2", "a.sql"])).toBe(
      "--min-lines is only valid for split and count",
    );
  });

  test("works together with --only and --dialect", () => {
    expect(
      parseArgs(["split", "--dialect", "mysql", "--only", "2", "--min-lines", "2", "a.sql"]),
    ).toEqual({ command: "split", dialect: "mysql", only: 2, minLines: 2, file: "a.sql" });
  });
});

describe("--min-lines through run", () => {
  test("split leaves out the short statements and keeps the numbers", () => {
    const h = makeIo(files);
    expect(run(["split", "--min-lines", "2", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe(
      [
        "-- #1 lines 2-5",
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  name TEXT NOT NULL DEFAULT 'a;b'",
        ")",
        "",
        "-- #4 lines 10-12",
        "SELECT",
        "  1,",
        "  2",
        "",
      ].join("\n"),
    );
    expect(h.err()).toBe("");
  });

  test("count counts only the statements that are left", () => {
    const h = makeIo(files);
    expect(run(["count", "--min-lines=2", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("2\n");
    const all = makeIo(files);
    expect(run(["count", "--min-lines", "1", "migrate.sql"], all.io)).toBe(0);
    expect(all.out()).toBe("4\n");
  });

  test("a value above every statement leaves nothing", () => {
    const h = makeIo(files);
    expect(run(["split", "--min-lines", "5", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("");
    const c = makeIo(files);
    expect(run(["count", "--min-lines", "5", "migrate.sql"], c.io)).toBe(0);
    expect(c.out()).toBe("0\n");
  });

  test("--only prints a statement that is long enough", () => {
    const h = makeIo(files);
    expect(run(["split", "--only", "4", "--min-lines", "3", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("-- #4 lines 10-12\nSELECT\n  1,\n  2\n");
  });

  test("--only refuses a statement that is too short", () => {
    const h = makeIo(files);
    expect(run(["split", "--only", "2", "--min-lines", "2", "migrate.sql"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: migrate.sql: statement 2 has fewer than 2 lines\n");
  });

  test("--only still reports a missing statement first", () => {
    const h = makeIo(files);
    expect(run(["split", "--only", "9", "--min-lines", "2", "migrate.sql"], h.io)).toBe(2);
    expect(h.err()).toBe("stmtsplit: migrate.sql: no statement 9 (the script has 4 statements)\n");
  });

  test("a script with problems is reported before the filter applies", () => {
    const h = makeIo({ "bad.sql": "SELECT 'a;\nSELECT 2;" });
    expect(run(["count", "--min-lines", "2", "bad.sql"], h.io)).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: bad.sql:1: unterminated string\n");
  });

  test("check refuses the option without reading the file", () => {
    const h = makeIo({});
    expect(run(["check", "--min-lines", "2", "migrate.sql"], h.io)).toBe(2);
    expect(h.err()).toBe("stmtsplit: --min-lines is only valid for split and count\n");
  });
});

describe("--min-lines documentation", () => {
  test("the usage lines name the option", () => {
    const h = makeIo({});
    expect(run(["--help"], h.io)).toBe(0);
    expect(h.out()).toContain("split [--dialect NAME] [--only N] [--min-lines N] FILE");
    expect(h.out()).toContain("count [--dialect NAME] [--min-lines N] FILE");
  });
});
