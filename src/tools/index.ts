/** Tool registry assembly. */
import { editTool, lsTool, readTool, writeTool } from "./files.js";
import { globTool, grepTool } from "./search.js";
import { shellTool } from "./shell.js";
import { readImageTool } from "./image.js";
import { makeSkillTool } from "./skill.js";
import { fetchTool, webSearchTool } from "./web.js";
import { makeTodoTool, TodoStore } from "./todo.js";
import { makeMemoryTool } from "./memory.js";
import { makeTaskTool, type SubagentDeps } from "../agent/subagent.js";
import { makeRunCodeTool } from "./codemode.js";
import { mcpToolDefs } from "../mcp/client.js";
import type { ToolDef } from "../types.js";
import type { Skill } from "../skills/loader.js";

export { TodoStore };

export interface RegistryOptions {
  skills: Skill[];
  /** Skills already in the history; the tool reports rather than resends them. */
  loadedSkills?: Set<string>;
  todo: TodoStore;
  onTodoChange: (store: TodoStore) => void;
  /** Project root the memory file lives under; omitted for subagents. */
  cwd?: string;
  /** Omitted for subagents so the tree stays one level deep. */
  subagentDeps?: SubagentDeps;
  /**
   * "minimal" keeps only shell and edit: quick fixes on cheap models, and a
   * baseline for measuring what the rest of the kit costs on every request.
   */
  preset?: "standard" | "minimal";
  /** Deps for the run_code tool; omitted when code mode is off. */
  runCode?: {
    confirmShell(command: string): Promise<boolean>;
    confirmWeb(kind: "search" | "fetch", target: string): Promise<boolean>;
  };
}

export function buildTools(opts: RegistryOptions): ToolDef[] {
  if (opts.preset === "minimal") return [shellTool, editTool];

  const tools: ToolDef[] = [readTool, editTool, writeTool, lsTool, globTool, grepTool, shellTool, readImageTool, webSearchTool, fetchTool];

  const skillTool = makeSkillTool(opts.skills, opts.loadedSkills);
  if (skillTool) tools.push(skillTool);

  tools.push(makeTodoTool(opts.todo, opts.onTodoChange));

  // Code mode is opt-in per model (config.codeMode): a program that gathers
  // data in one step instead of five saves its tokens only when it works.
  if (opts.runCode) tools.push(makeRunCodeTool(opts.runCode));

  // Memory is a lead-agent concern: subagents work one assignment and have
  // nothing durable to add to the project.
  if (opts.cwd) tools.push(makeMemoryTool(opts.cwd));

  // Connected MCP servers; subagents get them too, through deps.tools().
  tools.push(...mcpToolDefs());

  if (opts.subagentDeps) tools.push(makeTaskTool(opts.subagentDeps));

  return tools;
}
