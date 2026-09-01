/**
 * The favorites feature: a starred list in the config, the leading tab in
 * every one-model chooser, and /fav to manage it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-fav-"));
process.env.TRCODE_HOME = path.join(HOME, ".trcode");

const { loadConfig, saveConfig } = await import("../dist/config.js");
const { favoriteIds, toggleFavorite } = await import("../dist/ui/modelpicker.js");

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

const cat = [
  { id: "moonshotai/kimi-k3", modality: "text" },
  { id: "openai/gpt-5.2", modality: "text" },
  { id: "z-ai/glm-5.2", modality: "text" },
  { id: "qwen/qwen3.8-max", modality: "text" },
];
// The same lists once more than one host is connected: the favorites tab is
// how one crosses between them, so a star keeps its provider prefix.
const multi = [
  { id: "openrouter:openai/gpt-5.6-sol", modality: "text" },
  { id: "openrouter:z-ai/glm-5.3", modality: "text" },
  { id: "opencode-go:openai/gpt-5.6-sol", modality: "text" },
];

check("favorites default to empty", loadConfig().favoriteModels.length === 0);
check("favoriteIds over an empty list", favoriteIds(cat).length === 0);

check("toggleFavorite stars a model", toggleFavorite("z-ai/glm-5.2") === true);
check("the star survives a reload", loadConfig().favoriteModels.includes("z-ai/glm-5.2"));
check("toggleFavorite again unstages it", toggleFavorite("z-ai/glm-5.2") === false);
check("and the config agrees", !loadConfig().favoriteModels.includes("z-ai/glm-5.2"));

saveConfig({ favoriteModels: ["moonshotai/kimi-k3", "openai/gpt-5.2", "gone/old-model"] }, { replace: ["favoriteModels"] });
check(
  "favoriteIds keeps only models this catalog serves",
  JSON.stringify(favoriteIds(cat)) === JSON.stringify(["moonshotai/kimi-k3", "openai/gpt-5.2"]),
  JSON.stringify(favoriteIds(cat)),
);
check(
  "order follows the config, not the catalog",
  favoriteIds([...cat].reverse())[0] === "moonshotai/kimi-k3",
);

check("favorites span every provider by default", loadConfig().favoritesAllProviders === true);

saveConfig(
  {
    favoriteModels: [
      "openrouter:openai/gpt-5.6-sol",
      "opencode-go:openai/gpt-5.6-sol",
      "openrouter:z-ai/glm-5.3",
    ],
  },
  { replace: ["favoriteModels"] },
);
check(
  "with the setting on, a star from another host is listed",
  favoriteIds(multi, "openrouter:openai/gpt-5.6-sol").length === 3,
  JSON.stringify(favoriteIds(multi, "openrouter:openai/gpt-5.6-sol")),
);
saveConfig({ favoritesAllProviders: false });
check(
  "with it off, only what the provider in use serves",
  JSON.stringify(favoriteIds(multi, "openrouter:openai/gpt-5.6-sol")) ===
    JSON.stringify(["openrouter:openai/gpt-5.6-sol", "openrouter:z-ai/glm-5.3"]),
  JSON.stringify(favoriteIds(multi, "openrouter:openai/gpt-5.6-sol")),
);
check(
  "the setting narrows nothing when no model in use is named",
  favoriteIds(multi).length === 3,
  JSON.stringify(favoriteIds(multi)),
);
saveConfig({ favoritesAllProviders: true });

saveConfig({ favoriteModels: ["moonshotai/kimi-k3", "openai/gpt-5.2", "gone/old-model"] }, { replace: ["favoriteModels"] });
// An unrelated save must not corrupt the array into an object — that is what
// crashed every model panel with "favoriteModels.filter is not a function".
saveConfig({ model: "z-ai/glm-5.2" });
const afterOther = loadConfig().favoriteModels;
check(
  "an unrelated save keeps favoriteModels an array",
  Array.isArray(afterOther) && afterOther.includes("moonshotai/kimi-k3"),
  JSON.stringify(afterOther),
);
// A hand-corrupted file (object instead of array) is salvaged, not fatal.
const cfgPath = path.join(process.env.TRCODE_HOME, "config.json");
const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
raw.favoriteModels = { 0: "moonshotai/kimi-k3" };
fs.writeFileSync(cfgPath, JSON.stringify(raw));
// Any subsequent save must not propagate the corruption back into the file,
// and the next load reads a clean array.
saveConfig({ lang: "en" });
check(
  "a corrupt object-shaped favoriteModels is repaired on save",
  Array.isArray(loadConfig().favoriteModels),
  JSON.stringify(loadConfig().favoriteModels),
);

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* temp dir is disposable */
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
