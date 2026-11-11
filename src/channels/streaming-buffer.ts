/**
 * StreamingBuffer provides a rate-limited, markdown-safe buffer for progressive
 * message streaming over channels with rate limits (such as Telegram editMessageText).
 */

export interface StreamingBufferOptions {
  /** Throttle interval in milliseconds (default: 700ms for Telegram rate limit compliance) */
  throttleMs?: number;
  /** Minimum characters to accumulate before triggering an intermediate flush (default: 15) */
  minChunkChars?: number;
  /** Callback invoked on each throttled flush with current accumulated text */
  onFlush: (text: string, isFinal: boolean) => Promise<void> | void;
}

export class StreamingBuffer {
  private accumulated = "";
  private lastFlushed = "";
  private timer: any = null;
  private isFinalized = false;
  private isFlushing = false;
  private pendingFlush = false;
  private throttleMs: number;
  private minChunkChars: number;
  private onFlush: (text: string, isFinal: boolean) => Promise<void> | void;

  constructor(options: StreamingBufferOptions) {
    this.throttleMs = options.throttleMs ?? 700;
    this.minChunkChars = options.minChunkChars ?? 15;
    this.onFlush = options.onFlush;
  }

  /**
   * Appends incoming text chunk and schedules a throttled flush.
   */
  public append(chunk: string): void {
    if (this.isFinalized || !chunk) return;
    this.accumulated += chunk;

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tryFlush(false);
      }, this.throttleMs);
    }
  }

  /**
   * Returns current accumulated text.
   */
  public getText(): string {
    return this.accumulated;
  }

  /**
   * Flushes any remaining text and marks stream as complete.
   */
  public async flushFinal(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.tryFlush(true);
  }

  private async tryFlush(isFinal: boolean): Promise<void> {
    if (this.isFlushing) {
      this.pendingFlush = true;
      return;
    }

    // If nothing changed and not final, skip
    if (!isFinal && this.accumulated === this.lastFlushed) {
      return;
    }

    // If too few characters accumulated and not final, wait for next tick
    if (!isFinal && this.accumulated.length - this.lastFlushed.length < this.minChunkChars) {
      return;
    }

    this.isFlushing = true;
    const textToDeliver = this.accumulated;
    this.lastFlushed = textToDeliver;

    try {
      await this.onFlush(textToDeliver, isFinal);
    } catch {
      // Channel edit errors handled downstream
    } finally {
      this.isFlushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        void this.tryFlush(this.isFinalized);
      }
    }
  }
}

/**
 * Safely balances unclosed markdown syntax (fenced code blocks, inline code, bold)
 * for safe rendering during partial streaming snapshots.
 */
export function balanceStreamingMarkdown(text: string): string {
  if (!text) return "";

  let balanced = text;

  // 1. Balance triple-backtick code fences
  const fenceMatches = balanced.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    balanced += "\n```";
  }

  // 2. Balance single backticks (inline code) outside of code blocks
  const parts = balanced.split("```");
  for (let i = 0; i < parts.length; i += 2) {
    const inlineMatches = parts[i]?.match(/`/g);
    if (inlineMatches && inlineMatches.length % 2 !== 0) {
      parts[i] += "`";
    }
  }
  balanced = parts.join("```");

  return balanced;
}
