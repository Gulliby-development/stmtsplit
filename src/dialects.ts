export type Dialect = "ansi" | "postgres" | "mysql";

export const DIALECTS: readonly Dialect[] = ["ansi", "postgres", "mysql"];

export interface DialectRules {
  nestedBlockComments: boolean;
  dollarQuotes: boolean;
  escapeStrings: boolean;
  backslashEscapes: boolean;
  doubleQuoteIsString: boolean;
  backtickIdentifiers: boolean;
  hashComments: boolean;
  dashDashNeedsBlank: boolean;
  delimiterCommand: boolean;
}

const ANSI: DialectRules = {
  nestedBlockComments: false,
  dollarQuotes: false,
  escapeStrings: false,
  backslashEscapes: false,
  doubleQuoteIsString: false,
  backtickIdentifiers: false,
  hashComments: false,
  dashDashNeedsBlank: false,
  delimiterCommand: false,
};

const POSTGRES: DialectRules = {
  ...ANSI,
  nestedBlockComments: true,
  dollarQuotes: true,
  escapeStrings: true,
};

const MYSQL: DialectRules = {
  ...ANSI,
  backslashEscapes: true,
  doubleQuoteIsString: true,
  backtickIdentifiers: true,
  hashComments: true,
  dashDashNeedsBlank: true,
  delimiterCommand: true,
};

export function rulesFor(dialect: Dialect): DialectRules {
  if (dialect === "postgres") return POSTGRES;
  if (dialect === "mysql") return MYSQL;
  return ANSI;
}
