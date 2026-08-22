/**
 * Single owner of the terminal input stream.
 *
 * Previously every widget — the editor, the pickers, the permission prompt,
 * the secret reader — did its own setRawMode/resume/pause cycle. On Windows a
 * paused console stream does not always re-arm on resume: the next keystroke
 * wakes it and is swallowed, which reads as "the prompt is dead until I hit
 * Enter". Keeping the stream in raw+flowing mode for the whole session and
 * only swapping *listeners* removes that whole class of problem.
 */
export type InputConsumer = (chunk: Buffer) => void;

const stack: InputConsumer[] = [];
let attached = false;
let lastCtrlC = 0;

function dispatch(chunk: Buffer): void {
  // Safety net ahead of every widget: raw mode swallows SIGINT, so if the
  // consumer chain ever wedges, no key would work at all. A double Ctrl+C
  // within 1.5s always exits — the alternative is killing the terminal.
  if (chunk.length === 1 && chunk[0] === 3) {
    const now = Date.now();
    if (now - lastCtrlC < 1500) {
      releaseStdin();
      process.stdout.write("\x1b[?25h\n");
      process.exit(130);
    }
    lastCtrlC = now;
  }
  const top = stack[stack.length - 1];
  if (top) top(chunk);
  // With no consumer the bytes are dropped on purpose: nothing is waiting for
  // input, and buffering them would replay stale keystrokes later.
}

function ensureAttached(): void {
  if (attached || !process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* not a raw-capable stream */
  }
  process.stdin.resume();
  process.stdin.on("data", dispatch);
  attached = true;
}

/** Makes `fn` the active consumer; call the returned function to step back. */
export function pushConsumer(fn: InputConsumer): () => void {
  ensureAttached();
  stack.push(fn);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = stack.lastIndexOf(fn);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** True while some widget is reading. */
export function hasConsumer(): boolean {
  return stack.length > 0;
}

/** Hands the terminal back — used once, on shutdown. */
export function releaseStdin(): void {
  stack.length = 0;
  if (!attached) return;
  process.stdin.removeListener("data", dispatch);
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* already closed */
  }
  process.stdin.pause();
  attached = false;
}
