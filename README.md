<p align="center"><img src="docs/logo.svg" width="96" alt="" /></p>

# stmtsplit

stmtsplit is a command-line tool and a library that split a SQL script into its statements. It knows strings, quoted identifiers, comments, PostgreSQL dollar quotes and the MySQL `DELIMITER` command, so a `;` inside any of them does not end a statement. It works offline, reads the script only and never changes it.

It is for people who write migration runners, test setups or deploy scripts and have to send a script to a database driver that executes one statement at a time.

[![CI](https://github.com/Gulliby-development/stmtsplit/actions/workflows/ci.yml/badge.svg)](https://github.com/Gulliby-development/stmtsplit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

```
bun install
```

Run it with `bun run src/main.ts split FILE`. There is no build step.

## Usage

```
usage: stmtsplit split [--dialect NAME] [--only N] FILE
       stmtsplit count [--dialect NAME] FILE
       stmtsplit check [--dialect NAME] FILE
```

FILE is a path, or `-` for standard input. NAME is `ansi` (the default), `postgres` or `mysql`. The option is written `--dialect NAME` or `--dialect=NAME`; when it is repeated the last one wins, and options and FILE may come in any order. `--help` as the only argument prints the usage lines.

- `split` prints the statements, one block per statement, each with a header line giving its number and its line or lines. `--only N` (a whole number from 1 to 1000000, `split` only) prints only statement number N, with the same header; the numbers are those of the whole script.
- `count` prints the number of statements.
- `check` reports constructs that are not closed, or says that the script is ok with its number of statements.

Problems are reported as `DISPLAY:LINE: MESSAGE`, where DISPLAY is the file name as written (backslashes replaced by `/`, or `<stdin>`) and LINE is the line where the construct starts. `split` and `count` print the same lines on standard error with the prefix `stmtsplit: ` when the script has problems.

Example file `migrate.sql`:

```
-- create the tables
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'a;b'
);

/* seed; two rows */
INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y');
SELECT "weird;name" FROM users; -- trailing
```

`stmtsplit split migrate.sql` prints:

```
-- #1 lines 2-5
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'a;b'
)

-- #2 line 8
INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y')

-- #3 line 9
SELECT "weird;name" FROM users
```

`stmtsplit split --only 2 migrate.sql` prints:

```
-- #2 line 8
INSERT INTO users (id, name) VALUES (1, 'O''Brien'), (2, 'x -- y')
```

If the script has fewer than N statements, `stmtsplit: DISPLAY: no statement N (the script has M statements)` goes to standard error and the exit code is 2; a script with problems is reported first, as without the option.

## Dialects

- `ansi` (default): strings in single quotes with `''` as an escaped quote; quoted identifiers in double quotes with `""` inside; `--` line comments; `/* */` block comments that do not nest. A backslash, `$`, `#` and backticks are ordinary characters.
- `postgres`: as `ansi`, plus nested block comments, `E'...'` escape strings (a backslash escapes the next character) and dollar quotes such as `$$ ... $$` or `$tag$ ... $tag$` with an optional tag (tags are case-sensitive). `$1` and `a$b$c` are ordinary text.
- `mysql`: `#` line comments; `--` is a comment only when followed by a blank (space, tab or line end) or the end of the text; a backslash escapes the next character in both `'...'` and `"..."`; double quotes delimit strings; backticks delimit identifiers (a doubled backtick is the escaped form, no backslash escape); `/*! ... */` is an ordinary comment; the `DELIMITER` command changes the statement delimiter (it must come before a statement starts and be the first word on its line).

Problem messages: `unterminated string`, `unterminated quoted identifier` (also for a backtick identifier), `unterminated block comment`, `unterminated dollar quote` and `invalid DELIMITER command`. An unclosed construct runs to the end of the text.

## Exit codes

- 0: success.
- 1: the script has problems.
- 2: usage or input error (bad arguments, a file that cannot be read, input that is not valid UTF-8).

## Library

```ts
import { splitSql } from "./src/index";

const result = splitSql("SELECT 1; SELECT 2;", "postgres");

// result.statements: { index, startLine, endLine, text }[]
// result.problems: { line, message }[]
```

`splitSql(text, dialect = "ansi")` never throws. A `Statement` has `index` (from 1), `startLine`, `endLine` and `text`; a `Problem` has `line` and `message`. The types `Statement`, `Problem`, `ScanResult` and `Dialect` and the constant `DIALECTS` are exported too.

## Development

```
bun test
bun run typecheck
bun run lint
```

## License

MIT, see [LICENSE](LICENSE).

---

Built with BAKED.
