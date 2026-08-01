/** Plan tracking. Purely in-memory per session; keeps long tasks honest. */
import { c } from "../ui/ansi.js";
import type { ToolDef } from "../types.js";

export interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done";
}

export class TodoStore {
  items: TodoItem[] = [];

  replace(list: { text: string; status?: TodoItem["status"] }[]): void {
    this.items = list.map((t, i) => ({ id: i + 1, text: t.text, status: t.status ?? "pending" }));
  }

  render(): string {
    if (!this.items.length) return "(no plan yet)";
    return this.items
      .map((t) => {
        const mark =
          t.status === "done" ? c.green("✔") : t.status === "in_progress" ? c.brightYellow("▸") : c.gray("○");
        const text = t.status === "done" ? c.dim(t.text) : t.text;
        return `  ${mark} ${text}`;
      })
      .join("\n");
  }

  plain(): string {
    return this.items.map((t) => `${t.status === "done" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} ${t.text}`).join("\n");
  }
}

export function makeTodoTool(store: TodoStore, onChange: (s: TodoStore) => void): ToolDef {
  return {
    name: "todo",
    risk: "read",
    description:
      "Tracks the plan for multi-step work. Pass the COMPLETE list of items on every call — it replaces the previous one. " +
      "Exactly one item must be in_progress. Mark an item done the moment it is finished, not in a batch at the end. " +
      "One- or two-step tasks need no plan.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The complete list of plan items",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "What has to be done" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["items"],
    },
    summarize: (a) => {
      const items = (a.items ?? []) as TodoItem[];
      const done = items.filter((i) => i.status === "done").length;
      return `${done}/${items.length}`;
    },
    async run(args) {
      const raw = Array.isArray(args.items) ? args.items : [];
      if (!raw.length) return { output: "Empty list — the plan was not changed.", isError: true };
      store.replace(
        raw.map((r: any) => ({ text: String(r.text ?? "").trim(), status: r.status ?? "pending" })).filter((r) => r.text),
      );
      onChange(store);
      const inProgress = store.items.filter((i) => i.status === "in_progress").length;
      const hint = inProgress > 1 ? " Note: only one item may be in_progress at a time." : "";
      return { output: `Plan updated:\n${store.plain()}${hint}`, display: store.render() };
    },
  };
}
