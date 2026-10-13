import type { Problem, ScanResult, Statement } from "./scanner";

export function formatSplit(statements: Statement[]): string {
  return statements
    .map((statement) => {
      const lines =
        statement.startLine === statement.endLine
          ? `line ${statement.startLine}`
          : `lines ${statement.startLine}-${statement.endLine}`;
      return `-- #${statement.index} ${lines}\n${statement.text}\n`;
    })
    .join("\n");
}

export function formatProblems(display: string, problems: Problem[], prefix: string): string {
  return problems
    .map((problem) => `${prefix}${display}:${problem.line}: ${problem.message}\n`)
    .join("");
}

export function formatCheck(display: string, result: ScanResult): string {
  if (result.problems.length > 0) {
    return formatProblems(display, result.problems, "");
  }
  const count = result.statements.length;
  return `${display}: ok, ${count} ${count === 1 ? "statement" : "statements"}\n`;
}
