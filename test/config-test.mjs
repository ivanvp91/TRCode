/**
 * Writing the config must not carry a stale copy of it back to disk.
 *
 * A session loads the file once and keeps it for hours. Saving anything from
 * that snapshot — a learned reasoning form, a remembered provider — used to
 * rewrite every other field with it, so a setting changed meanwhile (by hand,
 * or by a second session) quietly reverted. That is how "maxSteps": 0 became
 * 60 again while its owner was watching.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-cfg-"));
process.env.TRCODE_HOME = HOME;
delete process.env.TOKENROUTER_API_KEY;
delete process.env.TR_API_KEY;
delete process.env.TOKENROUTER_BASE_URL;

const { loadConfig, saveConfig, configPath } = await import("../dist/config.js");

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
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), "utf8"));
const editOnDisk = (patch) => {
  fs.writeFileSync(configPath(), JSON.stringify({ ...onDisk(), ...patch }, null, 2) + "\n");
};

saveConfig({ model: "a/one", maxSteps: 60, aliases: { k: "a/one" } });
loadConfig(); // the long-lived session's snapshot: maxSteps 60

// Someone else — the user's editor, another session — removes the ceiling.
editOnDisk({ maxSteps: 0 });

// …and this session then saves something entirely unrelated.
saveConfig({ effortForm: { "a/one": "reasoning" } });

check("the other change survived an unrelated save", onDisk().maxSteps === 0, JSON.stringify(onDisk().maxSteps));
check("and the save itself landed", onDisk().effortForm["a/one"] === "reasoning", JSON.stringify(onDisk().effortForm));
check("loadConfig sees the file, not the snapshot", loadConfig().maxSteps === 0, String(loadConfig().maxSteps));

// Map-valued keys still merge, and `replace` still replaces.
saveConfig({ aliases: { m: "a/two" } });
check("maps merge", onDisk().aliases.k === "a/one" && onDisk().aliases.m === "a/two", JSON.stringify(onDisk().aliases));
saveConfig({ aliases: { only: "a/three" } }, { replace: ["aliases"] });
check("replace wins when asked", Object.keys(onDisk().aliases).join() === "only", JSON.stringify(onDisk().aliases));

// A key that lives only in the environment is not a setting to persist.
process.env.TOKENROUTER_API_KEY = "sk-from-env";
// A save re-reads afterwards, which is also what picks the new environment up.
saveConfig({ temperature: 0.3 });
check("the env key is what callers see", loadConfig().apiKey === "sk-from-env", String(loadConfig().apiKey));
check("but it is not written to the file", onDisk().apiKey !== "sk-from-env", String(onDisk().apiKey));
delete process.env.TOKENROUTER_API_KEY;

// The status line: all fields on by default, toggles merge, replace replaces.
check(
  "status fields are all on by default",
  Object.values(loadConfig().statusFields).every(Boolean),
  JSON.stringify(loadConfig().statusFields),
);
saveConfig({ statusFields: { speed: false } });
check("a toggle merges over the defaults", loadConfig().statusFields.speed === false && loadConfig().statusFields.model === true, JSON.stringify(loadConfig().statusFields));

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
