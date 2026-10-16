/** Tool registry assembly. */
import { editTool, lsTool, multiEditTool, readTool, writeTool } from "./files.js";
import { globTool, grepTool } from "./search.js";
import { shellTool } from "./shell.js";
import { shellIoTool } from "./procs.js";
import { readImageTool } from "./image.js";
import { prepareMediaTool } from "./mediaworkspace.js";
import { makeGenerateVideoTool, makeResumeMediaTool, videoAvailable } from "./video.js";
import { imageGenAvailable, makeGenerateImageTool } from "./imagegen.js";
import { audioGenAvailable, makeGenerateAudioTool } from "./audiogen.js";
import { makeSkillTool } from "./skill.js";
import { fetchTool, webSearchTool } from "./web.js";
import { makeTodoTool, TodoStore } from "./todo.js";
import { makeMemoryTool } from "./memory.js";
import { askUserQuestionTool } from "./questions.js";
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

function foregroundShell(): ToolDef {
  const { background: _, ...properties } = shellTool.parameters.properties as Record<string, unknown>;
  return { ...shellTool, parameters: { ...shellTool.parameters, properties } };
}

export function buildTools(opts: RegistryOptions): ToolDef[] {
  // Minimal has no shell_io, so nothing could talk to a background process.
  if (opts.preset === "minimal") return [foregroundShell(), editTool];

  const tools: ToolDef[] = [readTool, editTool, multiEditTool, writeTool, lsTool, globTool, grepTool, shellTool, shellIoTool, readImageTool, webSearchTool, fetchTool];

  // Media tools are offered only when the chosen model's host is connected:
  // otherwise they could only fail, and would cost a paragraph per request.
  if (videoAvailable()) tools.push(makeGenerateVideoTool());
  if (imageGenAvailable()) tools.push(makeGenerateImageTool());
  if (audioGenAvailable()) tools.push(makeGenerateAudioTool());
  if (videoAvailable() || imageGenAvailable() || audioGenAvailable()) tools.push(prepareMediaTool, makeResumeMediaTool());

  const skillTool = makeSkillTool(opts.skills, opts.loadedSkills);
  if (skillTool) tools.push(skillTool);

  tools.push(makeTodoTool(opts.todo, opts.onTodoChange));
  tools.push(askUserQuestionTool);

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
