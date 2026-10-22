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

/**
 * Asks the terminal which row the cursor is on, 1-based, or null when it does
 * not answer in time. The reply comes back on the input stream, so it is read
 * through a consumer of its own; anything typed before the prompt is up would
 * have been dropped anyway, and it still is.
 *
 * The stream is already in raw mode by the time the question is written:
 * attaching a consumer does that, and the mode stays on for the rest of the
 * session. It must not be switched back here — a console that has been handed
 * back its line mode stops reporting arrow keys and echoes what is typed, which
 * looks like a dead history and a lost input band.
 */
export function queryCursorRow(timeoutMs = 200): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let seen = "";
    let settled = false;
    const finish = (row: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve(row);
    };
    // The reply can arrive split across two reads, so the buffer grows until
    // the whole CSI sequence is in it.
    const release = pushConsumer((chunk) => {
      seen += chunk.toString("utf8");
      const m = /\x1b\[(\d+);(\d+)R/.exec(seen);
      if (m) finish(Number(m[1]));
      else if (seen.length > 32) finish(null);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    process.stdout.write("\x1b[6n");
  });
}
