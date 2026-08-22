/** The `skill` tool — loads a skill's full instructions on demand. */
import type { ToolDef } from "../types.js";
import type { Skill } from "../skills/loader.js";

export function makeSkillTool(skills: Skill[], loaded?: Set<string>): ToolDef | null {
  if (!skills.length) return null;
  const names = skills.map((s) => s.name);

  return {
    name: "skill",
    risk: "read",
    description:
      "Loads a skill's full instructions. Call it BEFORE starting work when the task matches a skill description from the <skills> block. " +
      `Available skills: ${names.join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name", enum: names },
      },
      required: ["name"],
    },
    summarize: (a) => String(a.name),
    async run(args) {
      const want = String(args.name ?? "").trim();
      const skill = skills.find((s) => s.name === want) ?? skills.find((s) => s.name.toLowerCase() === want.toLowerCase());
      if (!skill) {
        return { output: `Skill not found: ${want}. Available: ${names.join(", ")}`, isError: true };
      }
      // Already in this conversation — sending the body twice buys nothing and
      // is billed on every step from here on.
      if (loaded?.has(skill.name)) {
        return {
          output: `Skill "${skill.name}" is already loaded earlier in this conversation — scroll up to it instead of loading it again.`,
          display: `skill "${skill.name}" already loaded`,
        };
      }
      loaded?.add(skill.name);
      const res = skill.resources.length
        ? `\n\n<skill-resources dir="${skill.dir}">\nFiles ship alongside this skill — read them with the read tool as needed:\n${skill.resources
            .map((r) => `- ${skill.dir}/${r}`)
            .join("\n")}\n</skill-resources>`
        : "";
      return {
        output: `<skill name="${skill.name}">\n${skill.body}\n</skill>${res}`,
        display: `skill "${skill.name}" loaded (${skill.body.length} chars)`,
      };
    },
  };
}
