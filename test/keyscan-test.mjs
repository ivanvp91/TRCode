/** Checks that /keys labels agree with what the editor really does. */
import { EventEmitter } from "node:events";
const ESC = String.fromCharCode(27);
const stdin = new EventEmitter();
stdin.isTTY = true; stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin; stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

let out = "";
const real = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { out += String(chunk); return true; };

const { scanKeys } = await import("../dist/ui/keyscan.js");
const p = scanKeys();
const send = (s) => stdin.emit("data", Buffer.from(s, "utf8"));
send(ESC + "[13;5u");   // Ctrl+Enter
send(ESC + "\r");       // Alt+Enter
send(String.fromCharCode(10)); // Ctrl+Enter as LF
send(ESC + "[A");       // стрелка вверх
send("\r");             // Enter
send(ESC); send(ESC);   // выход
const seen = await p;
process.stdout.write = real;

const strip = (s) => s.replace(new RegExp(ESC + "\[[0-9;]*[A-Za-z]", "g"), "");
const rows = strip(out).split("\n").filter((l) => l.trim());
let failed = 0;
const check = (name, cond) => { if (!cond) failed++; console.log(`${cond ? "  OK  " : "  FAIL"}  ${name}`); };

// Match on the key column, not anywhere in the row: "<CR>" also occurs
// inside "<ESC><CR>".
const labelFor = (needle) => rows.find((r) => r.trim().startsWith(needle)) ?? "";
check("Ctrl+Enter labelled as newline", labelFor("<ESC>[13;5u").includes("insert a newline"));
check("Alt+Enter labelled as newline", labelFor("<ESC><CR>").includes("insert a newline"));
check("LF labelled as newline", labelFor("<LF>").includes("insert a newline"));
check("up arrow labelled as history", labelFor("<ESC>[A").includes("history"));
check("Enter labelled as send", labelFor("<CR>").includes("send the message"));
// Five keys plus the first Esc; the second Esc closes the scan.
check("six keys captured", seen.length === 6);
console.log(`\n${6 - failed}/6 пройдено`);
process.exit(failed ? 1 : 0);
