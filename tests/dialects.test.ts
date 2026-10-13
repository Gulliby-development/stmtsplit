import { describe, expect, test } from "bun:test";
import { DIALECTS, rulesFor } from "../src/dialects";
import { type ScanResult, splitSql } from "../src/scanner";

const texts = (r: ScanResult): string[] => r.statements.map((s) => s.text);
const spans = (r: ScanResult): number[][] => r.statements.map((s) => [s.startLine, s.endLine]);

const PG_SQL = [
  "CREATE FUNCTION bump() RETURNS trigger AS $$",
  "BEGIN",
  "  NEW.n := NEW.n + 1; RETURN NEW;",
  "END;",
  "$$ LANGUAGE plpgsql;",
  "SELECT $q$it's; ok$q$, E'a\\'b;c' /* outer /* inner; */ still comment; */;",
  "SELECT $1, a$b$c;",
  "",
].join("\n");

const MY_SQL = [
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
  "",
].join("\n");

describe("rulesFor", () => {
  test("DIALECTS order", () => {
    expect([...DIALECTS]).toEqual(["ansi", "postgres", "mysql"]);
  });

  test("ansi has every rule off", () => {
    expect(rulesFor("ansi")).toEqual({
      nestedBlockComments: false,
      dollarQuotes: false,
      escapeStrings: false,
      backslashEscapes: false,
      doubleQuoteIsString: false,
      backtickIdentifiers: false,
      hashComments: false,
      dashDashNeedsBlank: false,
      delimiterCommand: false,
    });
  });

  test("postgres rules", () => {
    expect(rulesFor("postgres")).toEqual({
      nestedBlockComments: true,
      dollarQuotes: true,
      escapeStrings: true,
      backslashEscapes: false,
      doubleQuoteIsString: false,
      backtickIdentifiers: false,
      hashComments: false,
      dashDashNeedsBlank: false,
      delimiterCommand: false,
    });
  });

  test("mysql rules", () => {
    expect(rulesFor("mysql")).toEqual({
      nestedBlockComments: false,
      dollarQuotes: false,
      escapeStrings: false,
      backslashEscapes: true,
      doubleQuoteIsString: true,
      backtickIdentifiers: true,
      hashComments: true,
      dashDashNeedsBlank: true,
      delimiterCommand: true,
    });
  });
});

describe("postgres", () => {
  test("pg.sql example", () => {
    const r = splitSql(PG_SQL, "postgres");
    expect(r.problems).toEqual([]);
    expect(texts(r)).toEqual([
      [
        "CREATE FUNCTION bump() RETURNS trigger AS $$",
        "BEGIN",
        "  NEW.n := NEW.n + 1; RETURN NEW;",
        "END;",
        "$$ LANGUAGE plpgsql",
      ].join("\n"),
      "SELECT $q$it's; ok$q$, E'a\\'b;c' /* outer /* inner; */ still comment; */",
      "SELECT $1, a$b$c",
    ]);
    expect(spans(r)).toEqual([
      [1, 5],
      [6, 6],
      [7, 7],
    ]);
    expect(r.statements.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  test("pg.sql example in ansi gives 7 statements", () => {
    const r = splitSql(PG_SQL);
    expect(r.problems).toEqual([]);
    expect(texts(r)).toEqual([
      "CREATE FUNCTION bump() RETURNS trigger AS $$\nBEGIN\n  NEW.n := NEW.n + 1",
      "RETURN NEW",
      "END",
      "$$ LANGUAGE plpgsql",
      "SELECT $q$it's; ok$q$, E'a\\'b;c' /* outer /* inner; */ still comment",
      "*/",
      "SELECT $1, a$b$c",
    ]);
    expect(spans(r)).toEqual([
      [1, 3],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [6, 6],
      [7, 7],
    ]);
  });

  test("nested block comments", () => {
    const text = "/* a /* b */ SELECT 1; */ x;\n";
    expect(texts(splitSql(text, "postgres"))).toEqual(["x"]);
    expect(texts(splitSql(text, "ansi"))).toEqual(["SELECT 1", "*/ x"]);
  });

  test("dollar quotes with a case-sensitive tag", () => {
    const r = splitSql("SELECT $a$ ; $A$ ; $$ ; $a$; SELECT 2", "postgres");
    expect(texts(r)).toEqual(["SELECT $a$ ; $A$ ; $$ ; $a$", "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("dollar quotes without a tag", () => {
    const r = splitSql("SELECT $$ ; $$; SELECT 2", "postgres");
    expect(texts(r)).toEqual(["SELECT $$ ; $$", "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("$1 and a$b$c are ordinary text", () => {
    const r = splitSql("SELECT $1, a$b$c; SELECT 2", "postgres");
    expect(texts(r)).toEqual(["SELECT $1, a$b$c", "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("E and e strings escape a quote with a backslash", () => {
    const upper = splitSql("SELECT E'a\\'; x'; SELECT 2", "postgres");
    expect(texts(upper)).toEqual(["SELECT E'a\\'; x'", "SELECT 2"]);
    const lower = splitSql("SELECT e'a\\'; x'; SELECT 2", "postgres");
    expect(texts(lower)).toEqual(["SELECT e'a\\'; x'", "SELECT 2"]);
    const first = splitSql("E'a\\'; x'; SELECT 2", "postgres");
    expect(texts(first)).toEqual(["E'a\\'; x'", "SELECT 2"]);
    expect(upper.problems).toEqual([]);
  });

  test("E after an identifier character is no escape string", () => {
    const r = splitSql("SELECT xE'a\\'; SELECT 2", "postgres");
    expect(texts(r)).toEqual(["SELECT xE'a\\'", "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("plain strings have no backslash escape in ansi", () => {
    const r = splitSql("SELECT E'a\\'; x'; SELECT 2");
    expect(texts(r)).toEqual(["SELECT E'a\\'", "x'; SELECT 2"]);
    expect(r.problems).toEqual([{ line: 1, message: "unterminated string" }]);
  });

  test("unclosed dollar quote", () => {
    const r = splitSql("SELECT 1;\nSELECT $a$ x;\n", "postgres");
    expect(r.problems).toEqual([{ line: 2, message: "unterminated dollar quote" }]);
    expect(texts(r)).toEqual(["SELECT 1", "SELECT $a$ x;"]);
    expect(spans(r)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test("unclosed block comment", () => {
    const text = "SELECT 1; /* never closed\nSELECT 2;\n";
    const expected = [{ line: 1, message: "unterminated block comment" }];
    expect(splitSql(text, "postgres").problems).toEqual(expected);
    expect(splitSql(text, "ansi").problems).toEqual(expected);
    expect(texts(splitSql(text, "postgres"))).toEqual(["SELECT 1"]);
  });

  test("200,000 dollar parameter statements", () => {
    const r = splitSql("SELECT $1;\n".repeat(200000), "postgres");
    expect(r.problems).toEqual([]);
    expect(r.statements.length).toBe(200000);
    const last = r.statements[199999];
    expect(last?.index).toBe(200000);
    expect(last?.startLine).toBe(200000);
    expect(last?.text).toBe("SELECT $1");
  });
});

describe("mysql", () => {
  test("my.sql example", () => {
    const r = splitSql(MY_SQL, "mysql");
    expect(r.problems).toEqual([]);
    expect(texts(r)).toEqual([
      "CREATE PROCEDURE p()\nBEGIN\n  SELECT 'a;b';\n  SELECT 2;\nEND",
      'SELECT `a;b`, "x\\"y;z" -- note',
      "SELECT 1--1",
    ]);
    expect(spans(r)).toEqual([
      [3, 7],
      [9, 9],
      [11, 11],
    ]);
  });

  test("hash comments", () => {
    const r = splitSql("SELECT 1 # c; d\n; SELECT 2", "mysql");
    expect(texts(r)).toEqual(["SELECT 1 # c; d", "SELECT 2"]);
    const ansi = splitSql("SELECT 1 # c; d\n; SELECT 2");
    expect(texts(ansi)).toEqual(["SELECT 1 # c", "d", "SELECT 2"]);
  });

  test("two dashes with and without a blank", () => {
    const r = splitSql("SELECT 1--1; SELECT 2 -- x; y", "mysql");
    expect(texts(r)).toEqual(["SELECT 1--1", "SELECT 2 -- x; y"]);
    expect(r.problems).toEqual([]);
    const tab = splitSql("SELECT 1 --\tx; y\n; SELECT 2", "mysql");
    expect(texts(tab)).toEqual(["SELECT 1 --\tx; y", "SELECT 2"]);
    const end = splitSql("SELECT 1; --", "mysql");
    expect(texts(end)).toEqual(["SELECT 1"]);
  });

  test("backslash escapes in single-quoted strings", () => {
    const r = splitSql("SELECT 'a\\'; x'; SELECT 2", "mysql");
    expect(texts(r)).toEqual(["SELECT 'a\\'; x'", "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("backslash escapes in double-quoted strings", () => {
    const r = splitSql('SELECT "a\\"; x"; SELECT 2', "mysql");
    expect(texts(r)).toEqual(['SELECT "a\\"; x"', "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("doubled quotes stay inside in both quote kinds", () => {
    const r = splitSql("SELECT 'a'';b', \"c\"\";d\"; SELECT 2", "mysql");
    expect(texts(r)).toEqual(["SELECT 'a'';b', \"c\"\";d\"", "SELECT 2"]);
  });

  test("backtick identifiers", () => {
    const doubled = splitSql("SELECT `a``;b`; SELECT 2", "mysql");
    expect(texts(doubled)).toEqual(["SELECT `a``;b`", "SELECT 2"]);
    const slash = splitSql("SELECT `a\\`; SELECT 2", "mysql");
    expect(texts(slash)).toEqual(["SELECT `a\\`", "SELECT 2"]);
    expect(doubled.problems).toEqual([]);
    expect(slash.problems).toEqual([]);
  });

  test("a backtick is ordinary text in ansi", () => {
    const r = splitSql("SELECT `a;b`");
    expect(texts(r)).toEqual(["SELECT `a", "b`"]);
  });

  test("/*! ... */ is an ordinary comment", () => {
    const r = splitSql("SELECT 1 /*! x; */ ; SELECT 2", "mysql");
    expect(texts(r)).toEqual(["SELECT 1 /*! x; */", "SELECT 2"]);
    expect(r.problems).toEqual([]);
  });

  test("DELIMITER with $$ and ;; and its reset in any letter case", () => {
    const text = [
      "DELIMITER $$",
      "SELECT 1; SELECT 2$$",
      "delimiter ;;",
      "SELECT 3;;",
      "DeLiMiTeR ;",
      "SELECT 4;",
    ].join("\n");
    const r = splitSql(text, "mysql");
    expect(r.problems).toEqual([]);
    expect(texts(r)).toEqual(["SELECT 1; SELECT 2", "SELECT 3", "SELECT 4"]);
    expect(spans(r)).toEqual([
      [2, 2],
      [4, 4],
      [6, 6],
    ]);
  });

  test("DELIMITER with // and indentation", () => {
    const r = splitSql("  \tDELIMITER //\nSELECT 1; SELECT 2//\nSELECT 3;", "mysql");
    expect(r.problems).toEqual([]);
    expect(texts(r)).toEqual(["SELECT 1; SELECT 2", "SELECT 3;"]);
  });

  test("invalid DELIMITER forms", () => {
    const r = splitSql("DELIMITER\nDELIMITER a b\nSELECT 1;\n", "mysql");
    expect(r.problems).toEqual([
      { line: 1, message: "invalid DELIMITER command" },
      { line: 2, message: "invalid DELIMITER command" },
    ]);
    expect(texts(r)).toEqual(["SELECT 1"]);
    expect(spans(r)).toEqual([[3, 3]]);
  });

  test("DELIMITER at the end of the text is invalid", () => {
    const r = splitSql("DELIMITER", "mysql");
    expect(r.problems).toEqual([{ line: 1, message: "invalid DELIMITER command" }]);
    expect(r.statements).toEqual([]);
  });

  test("DELIMITER after a statement has started is text", () => {
    const r = splitSql("SELECT 1\nDELIMITER //\n;", "mysql");
    expect(texts(r)).toEqual(["SELECT 1\nDELIMITER //"]);
    expect(spans(r)).toEqual([[1, 2]]);
    expect(r.problems).toEqual([]);
  });

  test("DELIMITER not at the start of its line is text", () => {
    const r = splitSql("/* c */ DELIMITER //\n;", "mysql");
    expect(texts(r)).toEqual(["DELIMITER //"]);
    expect(spans(r)).toEqual([[1, 1]]);
    expect(r.problems).toEqual([]);
  });

  test("DELIMITER text in ansi and postgres is one statement", () => {
    for (const dialect of ["ansi", "postgres"] as const) {
      const r = splitSql("DELIMITER //\nSELECT 1;\n", dialect);
      expect(texts(r)).toEqual(["DELIMITER //\nSELECT 1"]);
      expect(spans(r)).toEqual([[1, 2]]);
      expect(r.problems).toEqual([]);
    }
  });

  test("unterminated string after a backslash quote", () => {
    const text = "SELECT 'a\\'; SELECT 2;\nSELECT 3;\n";
    const r = splitSql(text, "mysql");
    expect(r.problems).toEqual([{ line: 1, message: "unterminated string" }]);
    expect(texts(splitSql(text))).toEqual(["SELECT 'a\\'", "SELECT 2", "SELECT 3"]);
    expect(splitSql(text).problems).toEqual([]);
  });

  test("unterminated double-quoted string is a string in mysql", () => {
    const r = splitSql('SELECT "abc;\n', "mysql");
    expect(r.problems).toEqual([{ line: 1, message: "unterminated string" }]);
  });

  test("unterminated backtick identifier", () => {
    const r = splitSql("SELECT 1;\nSELECT `abc;\n", "mysql");
    expect(r.problems).toEqual([{ line: 2, message: "unterminated quoted identifier" }]);
  });

  test("invalid DELIMITER then unterminated string", () => {
    const r = splitSql("DELIMITER\nSELECT 'x", "mysql");
    expect(r.problems).toEqual([
      { line: 1, message: "invalid DELIMITER command" },
      { line: 2, message: "unterminated string" },
    ]);
    expect(texts(r)).toEqual(["SELECT 'x"]);
  });
});
