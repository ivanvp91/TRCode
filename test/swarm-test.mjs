/**
 * The /swarm roster: a list chosen by hand, like /brain's panel, with the old
 * automatic pick as the fallback when nothing was chosen — and the synthesis
 * model that merges the answers at the end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-swarm-"));
process.env.TRCODE_HOME = path.join(HOME, ".trcode");

const { loadConfig, saveConfig } = await import("../dist/config.js");
const { configuredRoster, defaultRoster, swarmMain, swarmRoster } = await import("../dist/agent/swarm.js");

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

const M = (id, extra = {}) => ({ id, modality: "text", owner: id.split(":").pop().split("/")[0], ...extra });
const CURRENT = "openrouter:openai/gpt-5.6-sol";
const catalog = [
  M(CURRENT),
  M("openrouter:openai/gpt-5.6-luna"),
  M("openrouter:z-ai/glm-5.3"),
  M("opencode-go:anthropic/claude-opus-5"),
];

// ── the automatic pick ──────────────────────────────────────────────────────
check("nothing chosen means nothing configured", loadConfig().swarmModels.length === 0);
check("and no synthesis model either", loadConfig().swarmMainModel === "");

const auto = defaultRoster(catalog, CURRENT, 3);
check("the automatic roster opens on the session's model", auto[0] === CURRENT, JSON.stringify(auto));
check("it is three models", auto.length === 3, JSON.stringify(auto));
check(
  "one vendor each — that is the point of a swarm",
  new Set(auto.map((id) => id.split(":").pop().split("/")[0])).size === 3,
  JSON.stringify(auto),
);

// An embedding model taken for its vendor would fail on its first turn and
// quietly shrink the swarm to two.
const withDud = [
  M(CURRENT),
  M("openrouter:mistral/embed", { modality: "embedding", chatCapable: false }),
  M("openrouter:z-ai/glm-5.3"),
];
check(
  "a model this client cannot drive never joins the roster",
  !defaultRoster(withDud, CURRENT, 3).includes("openrouter:mistral/embed"),
  JSON.stringify(defaultRoster(withDud, CURRENT, 3)),
);

// ── a roster chosen by hand ─────────────────────────────────────────────────
const chosen = ["openrouter:openai/gpt-5.6-luna", "opencode-go:anthropic/claude-opus-5"];
saveConfig({ swarmModels: chosen }, { replace: ["swarmModels"] });
check(
  "the chosen roster is what runs",
  JSON.stringify(swarmRoster(catalog, CURRENT, 3)) === JSON.stringify(chosen),
  JSON.stringify(swarmRoster(catalog, CURRENT, 3)),
);
check(
  "the session's model is not forced onto a chosen roster",
  !swarmRoster(catalog, CURRENT, 3).includes(CURRENT),
);
check(
  "a member this client can no longer reach is dropped",
  JSON.stringify(configuredRoster([catalog[3]])) === JSON.stringify(["opencode-go:anthropic/claude-opus-5"]),
  JSON.stringify(configuredRoster([catalog[3]])),
);
// Nothing left of the chosen list is the same as never having chosen one.
check(
  "a roster nothing serves falls back to the automatic pick",
  JSON.stringify(swarmRoster([M(CURRENT), M("openrouter:z-ai/glm-5.3")], CURRENT, 3)) ===
    JSON.stringify([CURRENT, "openrouter:z-ai/glm-5.3"]),
  JSON.stringify(swarmRoster([M(CURRENT), M("openrouter:z-ai/glm-5.3")], CURRENT, 3)),
);

// ── who merges the answers ──────────────────────────────────────────────────
check("unpinned, the session's model writes the synthesis", swarmMain(CURRENT, chosen) === CURRENT);
saveConfig({ swarmMainModel: "opencode-go:anthropic/claude-opus-5" });
check(
  "pinned to a roster member, that model writes it",
  swarmMain(CURRENT, chosen) === "opencode-go:anthropic/claude-opus-5",
);
check(
  "a pin that is not on the roster is ignored, not obeyed",
  swarmMain(CURRENT, ["openrouter:z-ai/glm-5.3"]) === CURRENT,
);

// ── the config itself ───────────────────────────────────────────────────────
saveConfig({ swarmModels: ["openrouter:z-ai/glm-5.3"] }, { replace: ["swarmModels"] });
check(
  "a replace save rewrites the roster rather than appending",
  JSON.stringify(loadConfig().swarmModels) === JSON.stringify(["openrouter:z-ai/glm-5.3"]),
  JSON.stringify(loadConfig().swarmModels),
);
saveConfig({ lang: "en" });
check(
  "an unrelated save leaves the roster alone",
  JSON.stringify(loadConfig().swarmModels) === JSON.stringify(["openrouter:z-ai/glm-5.3"]),
  JSON.stringify(loadConfig().swarmModels),
);
// A hand-corrupted file (object instead of array) must not crash the panel.
const cfgPath = path.join(process.env.TRCODE_HOME, "config.json");
const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
raw.swarmModels = { 0: "openrouter:z-ai/glm-5.3" };
fs.writeFileSync(cfgPath, JSON.stringify(raw));
check(
  "an object-shaped swarmModels is salvaged on load",
  Array.isArray(loadConfig().swarmModels),
  JSON.stringify(loadConfig().swarmModels),
);

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* temp dir is disposable */
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
