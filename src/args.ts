import { DIALECTS, type Dialect } from "./dialects";

export class UsageError extends Error {}

export interface ParsedArgs {
  command: "split" | "count" | "check";
  dialect: Dialect;
  only?: number;
  file: string;
}

function isDialect(value: string): value is Dialect {
  return DIALECTS.some((dialect) => dialect === value);
}

function isCommand(value: string): value is ParsedArgs["command"] {
  return value === "split" || value === "count" || value === "check";
}

export function parseArgs(args: string[]): ParsedArgs {
  const command = args[0];
  if (command === undefined) {
    throw new UsageError("missing command (split, count or check)");
  }
  if (!isCommand(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  let dialectName = "ansi";
  let onlyValue: string | undefined;
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--dialect") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError("--dialect needs a value");
      }
      dialectName = value;
      i++;
    } else if (arg.startsWith("--dialect=")) {
      dialectName = arg.slice("--dialect=".length);
    } else if (arg === "--only") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError("--only needs a value");
      }
      onlyValue = value;
      i++;
    } else if (arg.startsWith("--only=")) {
      onlyValue = arg.slice("--only=".length);
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown option "${arg}"`);
    } else {
      positionals.push(arg);
    }
  }
  if (!isDialect(dialectName)) {
    throw new UsageError(`invalid --dialect "${dialectName}"`);
  }
  if (
    onlyValue !== undefined &&
    (!/^[1-9][0-9]*$/.test(onlyValue) || Number(onlyValue) > 1_000_000)
  ) {
    throw new UsageError(
      `invalid --only "${onlyValue}" (expected a whole number from 1 to 1000000)`,
    );
  }
  if (onlyValue !== undefined && command !== "split") {
    throw new UsageError("--only is only valid for split");
  }
  const file = positionals[0];
  if (file === undefined) {
    throw new UsageError("missing FILE");
  }
  if (positionals.length > 1) {
    throw new UsageError("too many arguments");
  }
  return {
    command,
    dialect: dialectName,
    ...(onlyValue === undefined ? {} : { only: Number(onlyValue) }),
    file,
  };
}
