# listtool

`listtool` reads items from standard input and prints them to your terminal
in the format you choose. It is a small command-line utility with no runtime
dependencies.

## Usage

```
listtool [options]
```

### Example

```
listtool --format json --max 50 --verbose
```

## Options

- `--format <table|json|csv>` — output format. Default: `json`.
- `--max <n>` — maximum number of items to print. Default: `10`.
- `--verbose` — print extra diagnostic output while running.
