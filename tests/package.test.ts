import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIALECTS, splitSql } from "stmtsplit";
import pkg from "stmtsplit/package.json";

test("the library is importable by the package name", () => {
  expect(DIALECTS).toEqual(["ansi", "postgres", "mysql"]);

  const result = splitSql("SELECT 1; SELECT 2;", "postgres");
  expect(result.statements.map(({ text }) => text)).toEqual(["SELECT 1", "SELECT 2"]);
  expect(result.problems).toEqual([]);
});

test("package.json maps the package name to the library entry", () => {
  expect(pkg.name).toBe("stmtsplit");
  expect(pkg.exports["."]).toBe("./src/index.ts");
  expect(pkg.exports["./package.json"]).toBe("./package.json");
});

test("README documents the import by package name", () => {
  const raw = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  const readme = raw.replaceAll("\r\n", "\n");
  expect(readme).toContain('import { splitSql } from "stmtsplit";');
});
