/**
 * Which model carries out an orchestration step.
 *
 * The planner could always return a "model" on a step and never did: it was
 * never told which models exist. It is told now — from the same shortlist
 * /subagents governs — so this pins down what may be offered, and that a name
 * the planner invented lands on the session's model instead of on a 404.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-orch-"));
process.env.TRCODE_HOME = path.join(HOME, ".trcode");

const { saveConfig } = await import("../dist/config.js");
const { resolveStepModel, stepModels } = await import("../dist/agent/orchestrator.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
};

const M = (id, extra = {}) => ({ id, modality: "text", ...extra });
const SESSION = "moonshotai/kimi-k3";
const app = {
  session: { model: SESSION },
  catalog: [
    M(SESSION),
    M("moonshotai/kimi-k3-free"),
    M("z-ai/glm-5.3"),
    M("kimi:k3"), // another provider — another key pays for it
    M("wan2.7-image", { modality: "image", chatCapable: false }),
  ],
};
const ids = (list) => list.map((m) => m.id);

// ── nothing chosen ──────────────────────────────────────────────────────────
check(
  "with no shortlist, every step runs on the session's model",
  JSON.stringify(ids(stepModels(app))) === JSON.stringify([SESSION]),
  JSON.stringify(ids(stepModels(app))),
);

// ── a shortlist, switched on ────────────────────────────────────────────────
saveConfig({
  subagentModels: { tokenrouter: ["moonshotai/kimi-k3-free", "z-ai/glm-5.3"] },
  subagentMode: { tokenrouter: "list" },
});
const offered = stepModels(app);
check("the shortlist is what the planner may choose from", offered.length === 3, JSON.stringify(ids(offered)));
check("the session's model leads the offer — it is the default", offered[0].id === SESSION, JSON.stringify(ids(offered)));
check(
  "and both listed models are on it",
  ids(offered).includes("moonshotai/kimi-k3-free") && ids(offered).includes("z-ai/glm-5.3"),
  JSON.stringify(ids(offered)),
);
check("another provider's model is never offered", !ids(offered).includes("kimi:k3"), JSON.stringify(ids(offered)));
check("nor a model that cannot answer", !ids(offered).includes("wan2.7-image"), JSON.stringify(ids(offered)));

// ── the same list, switched off ─────────────────────────────────────────────
saveConfig({ subagentMode: { tokenrouter: "session" } });
check(
  "a list left off narrows the offer back to the session's model",
  JSON.stringify(ids(stepModels(app))) === JSON.stringify([SESSION]),
  JSON.stringify(ids(stepModels(app))),
);
saveConfig({ subagentMode: { tokenrouter: "list" } });

// ── what a plan's "model" resolves to ───────────────────────────────────────
check("an id from the offer is taken as it is", resolveStepModel(offered, "z-ai/glm-5.3", SESSION) === "z-ai/glm-5.3");
check("a step with no model runs on the default", resolveStepModel(offered, undefined, SESSION) === SESSION);
check("a model nobody offered falls back", resolveStepModel(offered, "gpt-9-turbo", SESSION) === SESSION);
check("an empty offer means the default, whatever was asked for", resolveStepModel([], "z-ai/glm-5.3", SESSION) === SESSION);

// The planner echoes ids the way it reads them: a prefixed catalogue is often
// written back bare, and that must not cost the step its model.
const prefixed = [M("openrouter:z-ai/glm-5.3")];
check(
  "the bare spelling of a prefixed id still resolves",
  resolveStepModel(prefixed, "z-ai/glm-5.3", SESSION) === "openrouter:z-ai/glm-5.3",
  resolveStepModel(prefixed, "z-ai/glm-5.3", SESSION),
);

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* temp dir is disposable */
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
