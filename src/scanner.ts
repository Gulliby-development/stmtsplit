import { type Dialect, rulesFor } from "./dialects";

export interface Statement {
  index: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface Problem {
  line: number;
  message: string;
}

export interface ScanResult {
  statements: Statement[];
  problems: Problem[];
}

const LF = 10;

function isWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isLetterOrUnderscore(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isWordOrDollar(code: number): boolean {
  return isWordCode(code) || code === 36;
}

function normalize(input: string): string {
  let t = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (t.includes("\r\n")) t = t.split("\r\n").join("\n");
  return t;
}

/** Returns the index after the closing quote, or -1 when it is not closed. */
function scanQuoted(text: string, from: number, quote: string, escapes: boolean): number {
  const n = text.length;
  let j = from;
  while (j < n) {
    const ch = text[j];
    if (escapes && ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

export function splitSql(input: string, dialect: Dialect = "ansi"): ScanResult {
  const rules = rulesFor(dialect);
  const text = normalize(input);
  const n = text.length;
  const statements: Statement[] = [];
  const problems: Problem[] = [];
  let delimiter = ";";
  let line = 1;
  let start = -1;
  let startLine = 1;
  let blanks = true;
  let i = 0;

  const skipTo = (target: number): void => {
    const end = Math.min(target, n);
    while (i < end) {
      if (text.charCodeAt(i) === LF) line++;
      i++;
    }
  };

  const begin = (): void => {
    if (start < 0) {
      start = i;
      startLine = line;
    }
  };

  const close = (end: number, lineAtEnd: number): void => {
    if (start < 0) return;
    let e = end;
    let l = lineAtEnd;
    while (e > start && isWs(text.charCodeAt(e - 1))) {
      if (text.charCodeAt(e - 1) === LF) l--;
      e--;
    }
    statements.push({
      index: statements.length + 1,
      startLine,
      endLine: l,
      text: text.slice(start, e),
    });
    start = -1;
  };

  const quoted = (quote: string, escapes: boolean, message: string): void => {
    begin();
    const openLine = line;
    const end = scanQuoted(text, i + 1, quote, escapes);
    if (end < 0) {
      problems.push({ line: openLine, message });
      skipTo(n);
    } else {
      skipTo(end);
    }
    blanks = false;
  };

  while (i < n) {
    const code = text.charCodeAt(i);
    const c = text[i];

    if (text.startsWith(delimiter, i)) {
      close(i, line);
      i += delimiter.length;
      blanks = false;
      continue;
    }

    if (
      rules.delimiterCommand &&
      start < 0 &&
      blanks &&
      (c === "d" || c === "D") &&
      text.slice(i, i + 9).toLowerCase() === "delimiter"
    ) {
      const after = i + 9;
      const ac = text.charCodeAt(after);
      if (after >= n || ac === 32 || ac === 9 || ac === LF) {
        let lineEnd = text.indexOf("\n", after);
        if (lineEnd < 0) lineEnd = n;
        let a = after;
        let b = lineEnd;
        while (a < b && isWs(text.charCodeAt(a))) a++;
        while (b > a && isWs(text.charCodeAt(b - 1))) b--;
        const arg = text.slice(a, b);
        let valid = arg.length > 0;
        for (let k = 0; valid && k < arg.length; k++) {
          if (isWs(arg.charCodeAt(k))) valid = false;
        }
        if (valid) delimiter = arg;
        else problems.push({ line, message: "invalid DELIMITER command" });
        skipTo(lineEnd);
        continue;
      }
    }

    if (isWs(code)) {
      if (code === LF) {
        line++;
        blanks = true;
      } else if (code !== 32 && code !== 9) {
        blanks = false;
      }
      i++;
      continue;
    }

    const next = text[i + 1];

    if (
      (c === "-" && next === "-" && (!rules.dashDashNeedsBlank || isBlankAt(text, i + 2))) ||
      (c === "#" && rules.hashComments)
    ) {
      let end = text.indexOf("\n", i);
      if (end < 0) end = n;
      i = end;
      blanks = false;
      continue;
    }

    if (c === "/" && next === "*") {
      const openLine = line;
      let j = i + 2;
      let depth = 1;
      let closed = false;
      while (j < n) {
        if (text.startsWith("*/", j)) {
          depth--;
          j += 2;
          if (depth === 0) {
            closed = true;
            break;
          }
        } else if (rules.nestedBlockComments && text.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      if (!closed) problems.push({ line: openLine, message: "unterminated block comment" });
      skipTo(closed ? j : n);
      blanks = false;
      continue;
    }

    if (c === "'") {
      let escapes = rules.backslashEscapes;
      if (!escapes && rules.escapeStrings && i > 0) {
        const p = text[i - 1];
        if (p === "e" || p === "E") {
          escapes = i < 2 || !isWordOrDollar(text.charCodeAt(i - 2));
        }
      }
      quoted("'", escapes, "unterminated string");
      continue;
    }

    if (c === '"') {
      quoted(
        '"',
        rules.doubleQuoteIsString,
        rules.doubleQuoteIsString ? "unterminated string" : "unterminated quoted identifier",
      );
      continue;
    }

    if (c === "`" && rules.backtickIdentifiers) {
      quoted("`", false, "unterminated quoted identifier");
      continue;
    }

    if (c === "$" && rules.dollarQuotes && (i === 0 || !isWordOrDollar(text.charCodeAt(i - 1)))) {
      let j = i + 1;
      if (j < n && isLetterOrUnderscore(text.charCodeAt(j))) {
        j++;
        while (j < n && isWordCode(text.charCodeAt(j))) j++;
      }
      if (text[j] === "$") {
        begin();
        const openLine = line;
        const token = text.slice(i, j + 1);
        const found = text.indexOf(token, j + 1);
        if (found < 0) {
          problems.push({ line: openLine, message: "unterminated dollar quote" });
          skipTo(n);
        } else {
          skipTo(found + token.length);
        }
        blanks = false;
        continue;
      }
    }

    begin();
    blanks = false;
    i++;
  }

  close(n, line);
  return { statements, problems };
}

function isBlankAt(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const code = text.charCodeAt(index);
  return code === 32 || code === 9 || code === 10 || code === 13;
}
