import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { type Io, run } from "../src/cli";
import { formatCheck, formatProblems, formatSplit } from "../src/format";

const encoder = new TextEncoder();

interface Harness {
  io: Io;
  out: () => string;
  err: () => string;
  reads: string[];
  stdinReads: () => number;
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
  let stdinReads = 0;
  const reads: string[] = [];
  const io: Io = {
    readStdin() {
      stdinReads++;
      return stdinBytes;
    },
    readFile(path) {
      reads.push(path);
      const bytes = map.get(path);
      if (bytes === undefined) {
        throw new Error("ENOENT: secret operating system reason");
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
  return { io, out: () => out, err: () => err, reads, stdinReads: () => stdinReads };
}

const migrateLines = [
  "-- create the tables",
  "CREATE TABLE users (",
  "  id INTEGER PRIMARY KEY,",
  "  name TEXT NOT NULL DEFAULT 'a;b'",
  ");",
  "",
  "/* seed; two rows */",
  "INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y');",
  'SELECT "weird;name" FROM users; -- trailing',
];
const migrateSql = `${migrateLines.join("\n")}\n`;
const migrateBlock = migrateLines.join("\n");

const migrateOutputBlock = [
  "-- #1 lines 2-5",
  "CREATE TABLE users (",
  "  id INTEGER PRIMARY KEY,",
  "  name TEXT NOT NULL DEFAULT 'a;b'",
  ")",
  "",
  "-- #2 line 8",
  "INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y')",
  "",
  "-- #3 line 9",
  'SELECT "weird;name" FROM users',
].join("\n");

const pgSql = `${[
  "CREATE FUNCTION bump() RETURNS trigger AS $$",
  "BEGIN",
  "  NEW.n := NEW.n + 1; RETURN NEW;",
  "END;",
  "$$ LANGUAGE plpgsql;",
  "SELECT $q$it's; ok$q$, E'a\\'b;c' /* outer /* inner; */ still comment; */;",
  "SELECT $1, a$b$c;",
].join("\n")}\n`;

const pgOutput = `${[
  "-- #1 lines 1-5",
  "CREATE FUNCTION bump() RETURNS trigger AS $$",
  "BEGIN",
  "  NEW.n := NEW.n + 1; RETURN NEW;",
  "END;",
  "$$ LANGUAGE plpgsql",
  "",
  "-- #2 line 6",
  "SELECT $q$it's; ok$q$, E'a\\'b;c' /* outer /* inner; */ still comment; */",
  "",
  "-- #3 line 7",
  "SELECT $1, a$b$c",
].join("\n")}\n`;

const mySql = `${[
  "# setup",
  "DELIMITER //",
  "CREATE PROCEDURE p()",
  "BEGIN",
  "  SELECT 'a;b';",
  "  SELECT 2;",
  "END//",
  "DELIMITER ;",
  'SELECT `a;b`, "x\\"y;z" -- note',
  ";",
  "SELECT 1--1;",
].join("\n")}\n`;

const myOutput = `${[
  "-- #1 lines 3-7",
  "CREATE PROCEDURE p()",
  "BEGIN",
  "  SELECT 'a;b';",
  "  SELECT 2;",
  "END",
  "",
  "-- #2 line 9",
  'SELECT `a;b`, "x\\"y;z" -- note',
  "",
  "-- #3 line 11",
  "SELECT 1--1",
].join("\n")}\n`;

const usageLines = [
  "usage: stmtsplit split [--dialect NAME] FILE",
  "       stmtsplit count [--dialect NAME] FILE",
  "       stmtsplit check [--dialect NAME] FILE",
];
const usageText = `${usageLines.join("\n")}\n`;

describe("worked examples through run", () => {
  const files = { "migrate.sql": migrateSql, "pg.sql": pgSql, "my.sql": mySql };

  test("split migrate.sql", () => {
    const h = makeIo(files);
    expect(run(["split", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe(`${migrateOutputBlock}\n`);
    expect(h.err()).toBe("");
  });

  test("count migrate.sql", () => {
    const h = makeIo(files);
    expect(run(["count", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("3\n");
    expect(h.err()).toBe("");
  });

  test("check migrate.sql", () => {
    const h = makeIo(files);
    expect(run(["check", "migrate.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("migrate.sql: ok, 3 statements\n");
    expect(h.err()).toBe("");
  });

  test("split and count pg.sql with postgres", () => {
    const h = makeIo(files);
    expect(run(["split", "--dialect", "postgres", "pg.sql"], h.io)).toBe(0);
    expect(h.out()).toBe(pgOutput);
    expect(h.err()).toBe("");
    const c = makeIo(files);
    expect(run(["count", "pg.sql"], c.io)).toBe(0);
    expect(c.out()).toBe("7\n");
    expect(c.err()).toBe("");
  });

  test("split and check my.sql with mysql", () => {
    const h = makeIo(files);
    expect(run(["split", "--dialect=mysql", "my.sql"], h.io)).toBe(0);
    expect(h.out()).toBe(myOutput);
    expect(h.err()).toBe("");
    const c = makeIo(files);
    expect(run(["check", "--dialect", "mysql", "my.sql"], c.io)).toBe(0);
    expect(c.out()).toBe("my.sql: ok, 3 statements\n");
    expect(c.err()).toBe("");
  });
});

describe("input text and statement counts", () => {
  test("BOM and CRLF file", () => {
    const body = encoder.encode("SELECT 1;\r\n\r\nSELECT\r\n  2\r\n");
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf], 0);
    bytes.set(body, 3);
    const h = makeIo({ "crlf.sql": bytes });
    expect(run(["split", "crlf.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("-- #1 line 1\nSELECT 1\n\n-- #2 lines 3-4\nSELECT\n  2\n");
    expect(h.out()).not.toContain("\uFEFF");
    expect(h.out()).not.toContain("\r");
    expect(h.err()).toBe("");
  });

  test("script without statements", () => {
    const script = " ;; -- only a comment\n/* x */ ;\n";
    const h = makeIo({ "empty.sql": script });
    expect(run(["split", "empty.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("");
    const c = makeIo({ "empty.sql": script });
    expect(run(["count", "empty.sql"], c.io)).toBe(0);
    expect(c.out()).toBe("0\n");
    const k = makeIo({ "empty.sql": script });
    expect(run(["check", "empty.sql"], k.io)).toBe(0);
    expect(k.out()).toBe("empty.sql: ok, 0 statements\n");
    expect(k.err()).toBe("");
  });

  test("one statement is singular", () => {
    const h = makeIo({ "one.sql": "SELECT 1;\n" });
    expect(run(["check", "one.sql"], h.io)).toBe(0);
    expect(h.out()).toBe("one.sql: ok, 1 statement\n");
    expect(h.err()).toBe("");
  });
});

describe("problems", () => {
  const files = {
    "bad.sql": "SELECT 1;\nSELECT 'oops;\nSELECT 2;\n",
    "d.sql": "DELIMITER\nDELIMITER a b\nSELECT 1;\n",
  };

  test("check reports on stdout with exit 1", () => {
    const h = makeIo(files);
    expect(run(["check", "bad.sql"], h.io)).toBe(1);
    expect(h.out()).toBe("bad.sql:2: unterminated string\n");
    expect(h.err()).toBe("");
  });

  test("split and count report on stderr with exit 1", () => {
    for (const command of ["split", "count"]) {
      const h = makeIo(files);
      expect(run([command, "bad.sql"], h.io)).toBe(1);
      expect(h.out()).toBe("");
      expect(h.err()).toBe("stmtsplit: bad.sql:2: unterminated string\n");
    }
  });

  test("invalid DELIMITER commands", () => {
    const h = makeIo(files);
    expect(run(["check", "--dialect", "mysql", "d.sql"], h.io)).toBe(1);
    expect(h.out()).toBe(
      "d.sql:1: invalid DELIMITER command\nd.sql:2: invalid DELIMITER command\n",
    );
    expect(h.err()).toBe("");
    const s = makeIo(files);
    expect(run(["split", "--dialect", "mysql", "d.sql"], s.io)).toBe(1);
    expect(s.out()).toBe("");
    expect(s.err()).toBe(
      "stmtsplit: d.sql:1: invalid DELIMITER command\nstmtsplit: d.sql:2: invalid DELIMITER command\n",
    );
  });
});

describe("help", () => {
  test("--help as the sole argument", () => {
    const h = makeIo({});
    expect(run(["--help"], h.io)).toBe(0);
    expect(h.out()).toBe(usageText);
    expect(h.err()).toBe("");
  });

  test("--help followed by another argument", () => {
    const h = makeIo({});
    expect(run(["--help", "split"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe('stmtsplit: unknown command "--help"\n');
  });
});

interface UsageCase {
  args: string[];
  message: string;
  parseOnly?: boolean;
}

const usageCases: UsageCase[] = [
  { args: [], message: "missing command (split, count or check)" },
  { args: ["bogus"], message: 'unknown command "bogus"' },
  { args: ["--help"], message: 'unknown command "--help"', parseOnly: true },
  { args: ["--help", "split"], message: 'unknown command "--help"' },
  { args: ["split"], message: "missing FILE" },
  { args: ["split", "a", "b"], message: "too many arguments" },
  { args: ["split", "--x", "a"], message: 'unknown option "--x"' },
  { args: ["split", "--help"], message: 'unknown option "--help"' },
  { args: ["split", "--dialect"], message: "--dialect needs a value" },
  { args: ["check", "--dialect", "oracle", "x"], message: 'invalid --dialect "oracle"' },
  { args: ["split", "--dialect", "--x", "f"], message: 'invalid --dialect "--x"' },
  { args: ["split", "--dialect="], message: 'invalid --dialect ""' },
  { args: ["split", "--dialect", "oracle"], message: 'invalid --dialect "oracle"' },
  { args: ["split", "--dialect", "oracle", "--x"], message: 'unknown option "--x"' },
  { args: ["split", "a", "b", "--dialect", "oracle"], message: 'invalid --dialect "oracle"' },
];

describe("usage errors", () => {
  test("the table has 15 parseArgs lists and 14 run lists", () => {
    expect(usageCases.length).toBe(15);
    expect(usageCases.filter((c) => c.parseOnly !== true).length).toBe(14);
  });

  for (const { args, message } of usageCases) {
    test(`parseArgs [${args.join(" ")}]`, () => {
      let caught: unknown;
      try {
        parseArgs(args);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as UsageError).message).toBe(message);
    });
  }

  for (const { args, message, parseOnly } of usageCases) {
    if (parseOnly === true) {
      continue;
    }
    test(`run [${args.join(" ")}]`, () => {
      const h = makeIo({});
      expect(run(args, h.io)).toBe(2);
      expect(h.out()).toBe("");
      expect(h.err()).toBe(`stmtsplit: ${message}\n`);
      expect(h.reads).toEqual([]);
    });
  }
});

describe("parseArgs success", () => {
  test("dialect forms and order", () => {
    expect(parseArgs(["split", "a.sql"])).toEqual({
      command: "split",
      dialect: "ansi",
      file: "a.sql",
    });
    expect(parseArgs(["count", "--dialect", "mysql", "a.sql"])).toEqual({
      command: "count",
      dialect: "mysql",
      file: "a.sql",
    });
    expect(parseArgs(["check", "a.sql", "--dialect=postgres"])).toEqual({
      command: "check",
      dialect: "postgres",
      file: "a.sql",
    });
  });

  test("the last dialect wins", () => {
    const first = parseArgs(["split", "--dialect", "ansi", "--dialect=mysql", "a.sql"]);
    expect(first.dialect).toBe("mysql");
    const second = parseArgs(["split", "--dialect=mysql", "--dialect", "postgres", "a.sql"]);
    expect(second.dialect).toBe("postgres");
  });

  test("dash is a file", () => {
    expect(parseArgs(["split", "-"])).toEqual({ command: "split", dialect: "ansi", file: "-" });
  });
});

describe("input errors", () => {
  test("unreadable file", () => {
    const h = makeIo({});
    expect(run(["split", "nofile.sql"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: nofile.sql: cannot read the file\n");
    expect(h.err()).not.toContain("ENOENT");
  });

  test("unreadable file with a backslash is shown with a slash", () => {
    const h = makeIo({});
    expect(run(["count", "dir\\nofile.sql"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: dir/nofile.sql: cannot read the file\n");
    expect(h.reads).toEqual(["dir\\nofile.sql"]);
  });

  test("invalid UTF-8 in a file and in standard input", () => {
    const bytes = new Uint8Array([0x78, 0x20, 0xff, 0x0a]);
    const h = makeIo({ "bin.sql": bytes });
    expect(run(["check", "bin.sql"], h.io)).toBe(2);
    expect(h.out()).toBe("");
    expect(h.err()).toBe("stmtsplit: bin.sql: input is not valid UTF-8\n");
    const s = makeIo({}, bytes);
    expect(run(["check", "-"], s.io)).toBe(2);
    expect(s.out()).toBe("");
    expect(s.err()).toBe("stmtsplit: <stdin>: input is not valid UTF-8\n");
  });
});

describe("standard input", () => {
  test("count and check read standard input", () => {
    const c = makeIo({}, "SELECT 1; SELECT 2;\n");
    expect(run(["count", "-"], c.io)).toBe(0);
    expect(c.out()).toBe("2\n");
    expect(c.err()).toBe("");
    expect(c.reads).toEqual([]);
    expect(c.stdinReads()).toBe(1);
    const k = makeIo({}, "SELECT 1; SELECT 2;\n");
    expect(run(["check", "-"], k.io)).toBe(0);
    expect(k.out()).toBe("<stdin>: ok, 2 statements\n");
    expect(k.reads).toEqual([]);
  });

  test("an unterminated string on standard input", () => {
    const h = makeIo({}, "SELECT 'x\n");
    expect(run(["check", "-"], h.io)).toBe(1);
    expect(h.out()).toBe("<stdin>:1: unterminated string\n");
    expect(h.err()).toBe("");
  });
});

describe("file names with a backslash", () => {
  test("the file is read as written and named with a slash", () => {
    const h = makeIo({ "dir\\bad.sql": "SELECT 1;\nSELECT 'oops;\n" });
    expect(run(["check", "dir\\bad.sql"], h.io)).toBe(1);
    expect(h.reads).toEqual(["dir\\bad.sql"]);
    expect(h.out()).toBe("dir/bad.sql:2: unterminated string\n");
  });
});

describe("format functions", () => {
  const statements = [
    {
      index: 1,
      startLine: 2,
      endLine: 5,
      text: "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL DEFAULT 'a;b'\n)",
    },
    {
      index: 2,
      startLine: 8,
      endLine: 8,
      text: "INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y')",
    },
    { index: 3, startLine: 9, endLine: 9, text: 'SELECT "weird;name" FROM users' },
  ];
  const problems = [
    { line: 1, message: "invalid DELIMITER command" },
    { line: 2, message: "invalid DELIMITER command" },
  ];

  test("formatSplit", () => {
    expect(formatSplit(statements)).toBe(`${migrateOutputBlock}\n`);
    expect(formatSplit([])).toBe("");
  });

  test("formatCheck", () => {
    expect(formatCheck("f.sql", { statements: [], problems: [] })).toBe(
      "f.sql: ok, 0 statements\n",
    );
    expect(formatCheck("f.sql", { statements: statements.slice(0, 1), problems: [] })).toBe(
      "f.sql: ok, 1 statement\n",
    );
    expect(formatCheck("f.sql", { statements, problems: [] })).toBe("f.sql: ok, 3 statements\n");
    expect(formatCheck("f.sql", { statements, problems })).toBe(
      "f.sql:1: invalid DELIMITER command\nf.sql:2: invalid DELIMITER command\n",
    );
  });

  test("formatProblems", () => {
    const text = formatProblems("f.sql", problems, "stmtsplit: ");
    expect(text).toBe(
      "stmtsplit: f.sql:1: invalid DELIMITER command\nstmtsplit: f.sql:2: invalid DELIMITER command\n",
    );
    expect(text).not.toContain("\r");
    expect(formatProblems("f.sql", [], "stmtsplit: ")).toBe("");
  });
});

describe("README", () => {
  test("contains the documented parts", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    const readme = raw.replaceAll("\r\n", "\n");
    expect(readme).toContain(usageLines.join("\n"));
    expect(readme).toContain(migrateBlock);
    expect(readme).toContain(migrateOutputBlock);
    for (const heading of [
      "## Install",
      "## Usage",
      "## Dialects",
      "## Exit codes",
      "## Library",
      "## Development",
    ]) {
      expect(readme).toContain(heading);
    }
  });
});
