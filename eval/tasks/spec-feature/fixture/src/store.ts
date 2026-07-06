import { randomUUID } from "node:crypto";
import type { Status, Task } from "./types";

export interface NewTask {
  title: string;
  status?: Status;
  tags?: string[];
  createdAt?: number;
}

export function createTask(input: NewTask): Task {
  return {
    id: randomUUID(),
    title: input.title,
    status: input.status ?? "open",
    tags: input.tags ?? [],
    createdAt: input.createdAt ?? Date.now(),
  };
}

export class TaskStore {
  private tasks: Task[];

  constructor(initial: Task[] = []) {
    this.tasks = [...initial];
  }

  add(input: NewTask): Task {
    const t = createTask(input);
    this.tasks.push(t);
    return t;
  }

  all(): Task[] {
    return [...this.tasks];
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  complete(id: string): Task {
    const t = this.get(id);
    if (!t) throw new Error(`no such task: ${id}`);
    t.status = "done";
    return t;
  }

  remove(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    return this.tasks.length < before;
  }
}
