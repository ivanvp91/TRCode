/**
 * Output speed as a reader understands tok/s: tokens produced per second of
 * actual generation.
 *
 * Dividing the output of a turn by its wall clock looks reasonable and is not:
 * most of a turn is tool calls, a rate-limit wait or a request being resent,
 * and a 90-second build turned an honest 40 tok/s into 3 — while the step's own
 * exact count, taken from the last usage line, then made the figure fall again
 * every time a new step started. The meter below counts only time the model was
 * streaming: a burst opens on the first delta of a step, closes on the usage
 * line that ends it, and dies on its own after a pause, so a stall in the middle
 * of a step is not billed as generation either.
 */
const STALL_MS = 1500;

/** Below this there is not enough generation time to divide by. */
const MIN_MS = 400;

export class OutputRate {
  /** Output tokens seen streaming, in this turn. */
  private tokens = 0;
  /** Generation time of the bursts already closed, ms. */
  private closedMs = 0;
  /** When the running burst started; null while the model is not generating. */
  private openedAt: number | null = null;
  /** Last delta of the running burst, so a stall can end it. */
  private lastAt = 0;

  /** `clock` exists for the tests; production reads the wall clock. */
  constructor(private clock: () => number = Date.now) {}

  /** Some output just streamed in — the model is generating right now. */
  note(tokens: number): void {
    if (tokens <= 0) return;
    const now = this.clock();
    this.settle(now);
    if (this.openedAt === null) this.openedAt = now;
    this.lastAt = now;
    this.tokens += tokens;
  }

  /** The step is over: whatever happens next is not this model's generation. */
  close(): void {
    const now = this.clock();
    if (this.openedAt !== null) this.closedMs += Math.max(1, this.lastAt - this.openedAt);
    this.openedAt = null;
  }

  /** Generation time so far, ms; a burst still running counts up to now. */
  generationMs(): number {
    const now = this.clock();
    this.settle(now);
    return this.closedMs + (this.openedAt === null ? 0 : Math.max(1, now - this.openedAt));
  }

  /** Tokens per second of generation, or null while there is nothing to divide. */
  perSecond(): number | null {
    const ms = this.generationMs();
    if (!this.tokens || ms < MIN_MS) return null;
    return (this.tokens / ms) * 1000;
  }

  private settle(now: number): void {
    if (this.openedAt === null || now - this.lastAt <= STALL_MS) return;
    this.closedMs += Math.max(1, this.lastAt - this.openedAt);
    this.openedAt = null;
  }
}
