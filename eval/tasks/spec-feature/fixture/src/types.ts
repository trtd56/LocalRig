export type Status = "open" | "done";

export interface Task {
  id: string;
  title: string;
  status: Status;
  tags: string[];
  createdAt: number;
}
