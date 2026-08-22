/** Tool registry assembly. */
import { editTool, lsTool, readTool, writeTool } from "./files.js";
import { globTool, grepTool } from "./search.js";
import { shellTool } from "./shell.js";
import { makeSkillTool } from "./skill.js";
import { fetchTool, webSearchTool } from "./web.js";
import { makeTodoTool, TodoStore } from "./todo.js";
import { makeTaskTool, type SubagentDeps } from "../agent/subagent.js";
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
  /** Omitted for subagents so the tree stays one level deep. */
  subagentDeps?: SubagentDeps;
}

export function buildTools(opts: RegistryOptions): ToolDef[] {
  const tools: ToolDef[] = [readTool, editTool, writeTool, lsTool, globTool, grepTool, shellTool, webSearchTool, fetchTool];

  const skillTool = makeSkillTool(opts.skills, opts.loadedSkills);
  if (skillTool) tools.push(skillTool);

  tools.push(makeTodoTool(opts.todo, opts.onTodoChange));

  // Connected MCP servers; subagents get them too, through deps.tools().
  tools.push(...mcpToolDefs());

  if (opts.subagentDeps) tools.push(makeTaskTool(opts.subagentDeps));

  return tools;
}
