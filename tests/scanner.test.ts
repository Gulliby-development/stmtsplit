import { describe, expect, test } from "bun:test";
import type { Dialect } from "../src/dialects";
import { splitSql } from "../src/scanner";

const BOM = "\uFEFF";

function texts(sql: string, dialect?: Dialect): string[] {
  return splitSql(sql, dialect).statements.map((s) => s.text);
}

describe("ansi statements", () => {
  test("migrate.sql example", () => {
    const sql = [
      "-- create the tables",
      "CREATE TABLE users (",
      "  id INTEGER PRIMARY KEY,",
      "  name TEXT NOT NULL DEFAULT 'a;b'",
      ");",
      "",
      "/* seed; two rows */",
      "INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y');",
      'SELECT "weird;name" FROM users; -- trailing',
      "",
    ].join("\n");
    expect(splitSql(sql)).toEqual({
      statements: [
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
      ],
      problems: [],
    });
  });

  test("string with doubled quote and semicolon", () => {
    expect(texts("SELECT 'it''s;x'; SELECT 2")).toEqual(["SELECT 'it''s;x'", "SELECT 2"]);
  });

  test("identifier with doubled quote and semicolon", () => {
    expect(texts('SELECT "a"";b"; SELECT 2')).toEqual(['SELECT "a"";b"', "SELECT 2"]);
  });

  test("comments around a final statement without delimiter", () => {
    const result = splitSql("SELECT 1 -- c; d\n; SELECT 2 /* ; */ ; SELECT 3");
    expect(result.statements).toEqual([
      { index: 1, startLine: 1, endLine: 1, text: "SELECT 1 -- c; d" },
      { index: 2, startLine: 2, endLine: 2, text: "SELECT 2 /* ; */" },
      { index: 3, startLine: 2, endLine: 2, text: "SELECT 3" },
    ]);
    expect(result.problems).toEqual([]);
  });

  test("comments before, inside and after statements", () => {
    expect(texts("/* a */ -- b\nSELECT /* x; */ 1; /* c */\n-- d\nSELECT 2 -- e\n")).toEqual([
      "SELECT /* x; */ 1",
      "SELECT 2 -- e",
    ]);
  });

  test("block comments do not nest and /*/ is not closed by its own slash", () => {
    expect(texts("/*/ ; */ SELECT 1;")).toEqual(["SELECT 1"]);
    expect(texts("/* a /* b */ SELECT 1; */ x;\n")).toEqual(["SELECT 1", "*/ x"]);
  });

  test("empty statements are dropped", () => {
    for (const sql of [" ;; -- only a comment\n/* x */ ;\n", "", "   \n\t "]) {
      expect(splitSql(sql)).toEqual({ statements: [], problems: [] });
    }
  });

  test("comment after the last delimiter starts no statement", () => {
    const result = splitSql("SELECT 1; -- trailing");
    expect(result.statements).toEqual([{ index: 1, startLine: 1, endLine: 1, text: "SELECT 1" }]);
    expect(result.problems).toEqual([]);
  });

  test("backslash is ordinary in ansi", () => {
    const result = splitSql("SELECT 'a\\'; SELECT 2;\nSELECT 3;\n");
    expect(result.statements.map((s) => s.text)).toEqual(["SELECT 'a\\'", "SELECT 2", "SELECT 3"]);
    expect(result.problems).toEqual([]);
  });

  test("multi-line statements and trailing blank lines", () => {
    const result = splitSql("SELECT\n  1\n\n\n;\n\nSELECT 2");
    expect(result.statements).toEqual([
      { index: 1, startLine: 1, endLine: 2, text: "SELECT\n  1" },
      { index: 2, startLine: 7, endLine: 7, text: "SELECT 2" },
    ]);
  });

  test("a single statement with trailing whitespace only", () => {
    expect(splitSql("\n\nSELECT 1 \t\n\n\n").statements).toEqual([
      { index: 1, startLine: 3, endLine: 3, text: "SELECT 1" },
    ]);
  });
});

describe("input handling", () => {
  test("BOM and CRLF", () => {
    const result = splitSql(`${BOM}SELECT 1;\r\n\r\nSELECT\r\n  2\r\n`);
    expect(result.statements).toEqual([
      { index: 1, startLine: 1, endLine: 1, text: "SELECT 1" },
      { index: 2, startLine: 3, endLine: 4, text: "SELECT\n  2" },
    ]);
    for (const s of result.statements) {
      expect(s.text.includes(BOM)).toBe(false);
      expect(s.text.includes("\r")).toBe(false);
    }
  });

  test("only the first of two BOMs is skipped", () => {
    const result = splitSql(`${BOM}${BOM}SELECT 1;`);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]?.text).toBe(`${BOM}SELECT 1`);
  });

  test("lone CR is whitespace and does not count a line", () => {
    expect(splitSql("SELECT 1;\rSELECT\r2\r").statements).toEqual([
      { index: 1, startLine: 1, endLine: 1, text: "SELECT 1" },
      { index: 2, startLine: 1, endLine: 1, text: "SELECT\r2" },
    ]);
  });
});

describe("problems", () => {
  test("unterminated string", () => {
    const result = splitSql("SELECT 1;\nSELECT 'oops;\nSELECT 2;\n");
    expect(result.problems).toEqual([{ line: 2, message: "unterminated string" }]);
    expect(result.statements).toHaveLength(2);
    expect(result.statements[1]?.startLine).toBe(2);
    expect(result.statements[1]?.text.startsWith("SELECT 'oops;")).toBe(true);
  });

  test("unterminated quoted identifier", () => {
    const result = splitSql('SELECT "abc;\nSELECT 2;\n');
    expect(result.problems).toEqual([{ line: 1, message: "unterminated quoted identifier" }]);
    expect(result.statements).toHaveLength(1);
  });

  test("unterminated block comment", () => {
    const result = splitSql("SELECT 1; /* never closed\nSELECT 2;\n");
    expect(result.problems).toEqual([{ line: 1, message: "unterminated block comment" }]);
    expect(result.statements).toEqual([{ index: 1, startLine: 1, endLine: 1, text: "SELECT 1" }]);
  });
});

describe("robustness", () => {
  const inputs = ["", " \n\t ", BOM, "$", "'", '"', "`", "/*", "$a", "E'", "DELIMITER"];
  const dialects: Dialect[] = ["ansi", "postgres", "mysql"];

  test("never throws and returns arrays", () => {
    for (const input of inputs) {
      for (const dialect of dialects) {
        const result = splitSql(input, dialect);
        expect(Array.isArray(result.statements)).toBe(true);
        expect(Array.isArray(result.problems)).toBe(true);
      }
    }
  });
});

describe("performance", () => {
  test("200,000 statements", () => {
    const count = 200000;
    const result = splitSql("SELECT 1;\n".repeat(count));
    expect(result.problems).toEqual([]);
    expect(result.statements).toHaveLength(count);
    const last = result.statements[count - 1];
    expect(last?.index).toBe(count);
    expect(last?.startLine).toBe(count);
  });
});
