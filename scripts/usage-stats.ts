import fs from "node:fs";
import path from "node:path";

// Aggregates the per-model usage entries saved in ~/.trcode/sessions/**/*.json
const root = path.join(process.env.USERPROFILE ?? "", ".trcode", "sessions");

const perModel = new Map();
let files = 0;

function walk(dir: string): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".json")) {
			files++;
			let j: any;
			try {
				j = JSON.parse(fs.readFileSync(p, "utf8"));
			} catch {
				continue;
			}
			if (!Array.isArray(j.usage)) continue;
			for (const u of j.usage) {
				const m = u.model ?? "?";
				let t = perModel.get(m);
				if (!t) perModel.set(m, (t = { requests: 0, input: 0, output: 0, cached: 0, reasoning: 0 }));
				t.requests += u.requests ?? 0;
				t.input += u.input ?? 0;
				t.output += u.output ?? 0;
				t.cached += u.cached ?? 0;
				t.reasoning += u.reasoning ?? 0;
			}
		}
	}
}

walk(root);

const fmt = (n: number) => n.toLocaleString("en-US");
const rows = [...perModel.entries()].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
for (const [m, t] of rows) {
	console.log(
		m.padEnd(36),
		"req=" + fmt(t.requests).padStart(6),
		"input=" + fmt(t.input).padStart(14),
		"output=" + fmt(t.output).padStart(11),
		"cached=" + fmt(t.cached).padStart(14),
	);
}

const alpha = rows.find(([m]) => m.includes("ox-alpha"))?.[1];
if (alpha) {
	console.log("\n=== openrouter:stealth/ox-alpha ===");
	console.log("requests:", fmt(alpha.requests));
	console.log("input total:", fmt(alpha.input));
	console.log("  cached:", fmt(alpha.cached), `(${((alpha.cached / alpha.input) * 100).toFixed(1)}%)`);
	console.log("  fresh :", fmt(alpha.input - alpha.cached), `(${(((alpha.input - alpha.cached) / alpha.input) * 100).toFixed(1)}%)`);
	console.log("output:", fmt(alpha.output), "(reasoning:", fmt(alpha.reasoning) + ")");
	console.log("files scanned:", files);
}
