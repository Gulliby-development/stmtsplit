import { parseArgs, UsageError } from "./args";
import { formatCheck, formatProblems, formatSplit } from "./format";
import { splitSql } from "./scanner";

export interface Io {
  readStdin(): Uint8Array;
  readFile(path: string): Uint8Array;
  out(text: string): void;
  err(text: string): void;
}

const USAGE =
  "usage: stmtsplit split [--dialect NAME] FILE\n" +
  "       stmtsplit count [--dialect NAME] FILE\n" +
  "       stmtsplit check [--dialect NAME] FILE\n";

export function run(args: string[], io: Io): number {
  if (args.length === 1 && args[0] === "--help") {
    io.out(USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`stmtsplit: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const { command, dialect, file } = parsed;
  const display = file === "-" ? "<stdin>" : file.replaceAll("\\", "/");
  let bytes: Uint8Array;
  try {
    bytes = file === "-" ? io.readStdin() : io.readFile(file);
  } catch {
    io.err(`stmtsplit: ${display}: cannot read the file\n`);
    return 2;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    io.err(`stmtsplit: ${display}: input is not valid UTF-8\n`);
    return 2;
  }
  const result = splitSql(text, dialect);
  if (command === "check") {
    io.out(formatCheck(display, result));
    return result.problems.length > 0 ? 1 : 0;
  }
  if (result.problems.length > 0) {
    io.err(formatProblems(display, result.problems, "stmtsplit: "));
    return 1;
  }
  if (command === "count") {
    io.out(`${result.statements.length}\n`);
    return 0;
  }
  const output = formatSplit(result.statements);
  if (output !== "") {
    io.out(output);
  }
  return 0;
}
