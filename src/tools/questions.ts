/** Structured clarification: collect the whole batch before returning to the agent. */
import type { ToolDef } from "../types.js";

export interface UserQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

export interface UserAnswer {
  question: string;
  selected: string[];
  custom?: string;
}

/** Validate before taking over stdin, including callers that ignore the schema. */
export function parseQuestions(raw: unknown): UserQuestion[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new Error("Provide 1–4 questions.");
  const text = (value: unknown, max: number, field: string): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value)) {
      throw new Error(`${field} must be nonempty plain text (at most ${max} characters).`);
    }
    return value.trim();
  };
  return raw.map((q) => {
    if (!q || typeof q !== "object" || Array.isArray(q)) throw new Error("Each question must be an object.");
    const options = q.options ?? [];
    if (!Array.isArray(options) || options.length > 6) throw new Error("Provide at most 6 options per question; omit options for a free-text answer.");
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") throw new Error("multiSelect must be a boolean.");
    const parsed = options.map((o) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("Each option must be an object.");
      return { label: text(o.label, 200, "Option label"), ...(o.description === undefined ? {} : { description: text(o.description, 1000, "Option description") }) };
    });
    if (new Set(parsed.map((o) => o.label)).size !== parsed.length) throw new Error("Option labels must be unique within a question.");
    return {
      question: text(q.question, 2000, "Question"),
      ...(q.header === undefined ? {} : { header: text(q.header, 40, "Header") }),
      options: parsed,
      multiSelect: q.multiSelect === true,
    };
  });
}

export const askUserQuestionTool: ToolDef = {
  name: "ask_user_question",
  risk: "read",
  description:
    "Ask the user to resolve a meaningful ambiguity or choose how the task should be done. " +
    "The CLI shows a step-by-step modal with choices, a custom answer, review and Submit. " +
    "Batch 1–4 related questions; give concise options with tradeoffs and put the recommended option first. " +
    "Do not include an Other option: the UI always provides custom input. Omit options for free text. " +
    "Use multiSelect only when several answers can apply. Do not ask about facts you can inspect or decisions already made. " +
    "Wait for the submitted answers before doing work that depends on them. This is not a tool-permission gate.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", maxLength: 2000, description: "Self-contained question in the user's language" },
            header: { type: "string", maxLength: 40, description: "Short heading for this step" },
            options: {
              type: "array", maxItems: 6,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", maxLength: 200 },
                  description: { type: "string", maxLength: 1000, description: "Short explanation of the tradeoff" },
                },
                required: ["label"],
              },
            },
            multiSelect: { type: "boolean", description: "Allow selecting multiple options (default false)" },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
  summarize: (args) => `${Array.isArray(args.questions) ? args.questions.length : 0} question(s)`,
  async run(args, ctx) {
    let questions: UserQuestion[];
    try { questions = parseQuestions(args.questions); }
    catch (err) { return { output: (err as Error).message, isError: true }; }
    if (ctx.signal.aborted) return { output: JSON.stringify({ status: "cancelled" }) };
    if (!ctx.askUser) return {
      output: JSON.stringify({ status: "unavailable", message: "Interactive questions are unavailable. Ask the user in your reply and wait; do not invent answers or retry this tool." }),
      isError: true,
    };
    const answers = await ctx.askUser(questions);
    if (!answers) return { output: JSON.stringify({ status: ctx.signal.aborted ? "cancelled" : "unavailable", message: "No answers were submitted. Do not assume the highlighted options were chosen." }) };
    return {
      output: JSON.stringify({ status: "answered", answers }),
      display: answers.map((a) => `${a.question}\n  ${[...a.selected, ...(a.custom ? [a.custom] : [])].join("; ")}`).join("\n"),
    };
  },
};
