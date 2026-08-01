import { EventEmitter } from "node:events";
const ESC = String.fromCharCode(27);
const stdin = new EventEmitter();
stdin.isTTY = true; stdin.isRaw = false;
stdin.setRawMode = v => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin; stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });

let log = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { log.push(String(chunk)); return true; };

const { InputEditor } = await import("../dist/ui/editor.js");
const ed = new InputEditor({ status: () => ({ left: "L", hint: "H", context: "C" }), history: [] });

const p1 = ed.read();
stdin.emit("data", Buffer.from("a"));
stdin.emit("data", Buffer.from("\r"));
await p1;
const afterFirst = log.join("");
log = [];
const p2 = ed.read();
stdin.emit("data", Buffer.from("b"));
stdin.emit("data", Buffer.from("\r"));
await p2;
const afterSecond = log.join("");
process.stdout.write = realWrite;

const seq = s => (s.match(/\u001b\[[0-9?]*[A-Za-z]/g) || []).join(" ");
console.log("первый ввод, управляющие последовательности:");
console.log("  " + seq(afterFirst));
console.log("второй ввод:");
console.log("  " + seq(afterSecond));
console.log("\nесть ли очистка (0J) перед перерисовкой:", afterSecond.includes("\u001b[0J") ? "ДА" : "НЕТ");
console.log("есть ли up(0) — терминал трактует как up(1):", /\u001b\[0A/.test(afterFirst + afterSecond) ? "ЕСТЬ — БАГ" : "нет");
