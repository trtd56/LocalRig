import type { Task } from "./types";

// search() filters a list of tasks by a query written in the mini-language
// described in SPEC.md. It is not implemented yet: read SPEC.md and build it
// on top of src/query/parse.ts (string -> structured filters) and
// src/query/apply.ts (apply filters to tasks).
export function search(_tasks: Task[], _query: string): Task[] {
  throw new Error("search() is not implemented yet — see SPEC.md");
}
