import type { Task } from "./types";

// A small, fixed dataset used by the demo/tests so the app has something to
// show. Ids and createdAt are stable so results are deterministic.
export function sampleTasks(): Task[] {
  return [
    { id: "1", title: "Write the design doc", status: "open", tags: ["docs", "urgent"], createdAt: 1 },
    { id: "2", title: "Review pull request", status: "done", tags: ["code"], createdAt: 2 },
    { id: "3", title: "Fix login bug", status: "open", tags: ["code", "urgent"], createdAt: 3 },
    { id: "4", title: "Write release notes", status: "open", tags: ["docs"], createdAt: 4 },
    { id: "5", title: "Deploy to staging", status: "done", tags: ["ops"], createdAt: 5 },
  ];
}
