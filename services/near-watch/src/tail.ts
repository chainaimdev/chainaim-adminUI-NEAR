/**
 * The file road for claims: follow the paywall's payment log file
 * (--paywall-log-file, the file the paywall's PAYMENT_LOG_FILE sink appends
 * to), one JSON line per settled payment.
 *
 * The read offset is stored in the SQLite meta table (key tail:<absolute
 * path>), so a restart neither re-reads nor skips lines; claims are keyed by
 * (network, hash) anyway, so a line read twice changes nothing. Only complete
 * lines (ending in \n) are consumed: a line still being written is read on a
 * later tick. A file that shrank (truncated) or was replaced (different file
 * identity) is read again from the start. A line longer than the chunk size
 * cannot be a payment_settled line and is skipped with an alert.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "./store.ts";

export type TailOptions = {
  path: string;
  pollMs: number;
  /** Most bytes read per tick. */
  maxChunkBytes?: number;
  /** One complete line (without its line ending). Errors are the caller's to report. */
  onLine: (line: string) => void;
  /** Problems with the file itself (missing, rotated, an oversized line). */
  onProblem: (level: "info" | "warn", code: string, message: string) => void;
};

type Saved = { offset: number; id: string };

export class FileTail {
  readonly path: string;
  readonly counters = { lines: 0, rotations: 0, skipped: 0 };
  private readonly key: string;
  private readonly opts: TailOptions;
  private readonly store: Store;
  private readonly max: number;
  private timer: NodeJS.Timeout | null = null;
  private missingReported = false;

  constructor(store: Store, opts: TailOptions) {
    this.store = store;
    this.opts = opts;
    this.path = resolve(opts.path);
    this.key = `tail:${this.path}`;
    this.max = opts.maxChunkBytes ?? 1024 * 1024;
  }

  private saved(): Saved {
    const raw = this.store.getMeta(this.key);
    if (!raw) return { offset: 0, id: "" };
    try {
      const s = JSON.parse(raw) as Saved;
      return Number.isSafeInteger(s.offset) && s.offset >= 0 && typeof s.id === "string" ? s : { offset: 0, id: "" };
    } catch {
      return { offset: 0, id: "" };
    }
  }

  /** Read what is new; returns the number of complete lines handed on. */
  tick(): number {
    let st;
    try {
      st = statSync(this.path, { bigint: false });
    } catch {
      if (!this.missingReported) this.opts.onProblem("warn", "paywall_log_missing", `${this.path} does not exist yet; waiting for the paywall to write it`);
      this.missingReported = true;
      return 0;
    }
    this.missingReported = false;
    const id = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    let { offset, id: savedId } = this.saved();
    if ((savedId !== "" && savedId !== id) || st.size < offset) {
      this.counters.rotations += 1;
      this.opts.onProblem("info", "paywall_log_rotated", `${this.path} was replaced or truncated; reading it from the start`);
      offset = 0;
    }
    if (st.size === offset) {
      if (savedId !== id) this.store.setMeta(this.key, JSON.stringify({ offset, id }));
      return 0;
    }
    const length = Math.min(st.size - offset, this.max);
    const buf = Buffer.alloc(length);
    const fd = openSync(this.path, "r");
    let read: number;
    try {
      read = readSync(fd, buf, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    const chunk = buf.subarray(0, read);
    const end = chunk.lastIndexOf(0x0a);
    let consumed: number;
    let lines = 0;
    if (end === -1) {
      if (read < this.max) return 0; // a line still being written
      this.counters.skipped += 1;
      this.opts.onProblem("warn", "paywall_log_line_too_long", `${this.path}: a line longer than ${this.max} bytes at offset ${offset} was skipped`);
      consumed = read;
    } else {
      consumed = end + 1;
      for (const raw of chunk.subarray(0, end).toString("utf8").split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim() === "") continue;
        lines += 1;
        this.opts.onLine(line);
      }
    }
    this.counters.lines += lines;
    this.store.setMeta(this.key, JSON.stringify({ offset: offset + consumed, id }));
    return lines;
  }

  start(): void {
    if (this.timer) return;
    const safeTick = (): void => {
      try {
        this.tick();
      } catch (e) {
        this.opts.onProblem("warn", "paywall_log_error", `${this.path}: ${(e as Error).message}`);
      }
    };
    safeTick();
    this.timer = setInterval(safeTick, this.opts.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
