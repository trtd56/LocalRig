// A tiny "list" command with a hand-written argument parser.
// The flag names and default values defined here are the source of truth;
// README.md is expected to describe exactly what this file implements.

export type Format = "table" | "json" | "csv";
export type Sort = "name" | "date";

export interface Options {
  format: Format;
  limit: number;
  sort: Sort;
  verbose: boolean;
}

const FORMATS: Format[] = ["table", "json", "csv"];
const SORTS: Sort[] = ["name", "date"];

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    format: "table",
    limit: 25,
    sort: "name",
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--format": {
        const value = argv[++i];
        if (!value || !FORMATS.includes(value as Format)) {
          throw new Error(`invalid --format: ${value ?? "(missing)"}`);
        }
        opts.format = value as Format;
        break;
      }
      case "--limit": {
        const value = argv[++i];
        const n = Number(value);
        if (!value || !Number.isInteger(n) || n < 0) {
          throw new Error(`invalid --limit: ${value ?? "(missing)"}`);
        }
        opts.limit = n;
        break;
      }
      case "--sort": {
        const value = argv[++i];
        if (!value || !SORTS.includes(value as Sort)) {
          throw new Error(`invalid --sort: ${value ?? "(missing)"}`);
        }
        opts.sort = value as Sort;
        break;
      }
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return opts;
}

export function main(argv: string[]): void {
  const opts = parseArgs(argv);
  // Rendering real rows is out of scope for this fixture; echo the resolved
  // options so the effective configuration is observable from the outside.
  console.log(JSON.stringify(opts));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
