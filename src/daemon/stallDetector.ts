export interface StallDetectorOptions {
  stallMs: number;
  timeoutMs: number;
  onStall: () => void;
  onTimeout: () => void;
}

/**
 * Watches a running job: `recordEvent()` must be called on every parsed
 * stream event. If no event arrives within `stallMs`, `onStall` fires once.
 * Independently, `onTimeout` fires once when the wall clock exceeds
 * `timeoutMs` from `start()`.
 */
export class StallDetector {
  private stallTimer: NodeJS.Timeout | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: StallDetectorOptions) {}

  start(): void {
    this.timeoutTimer = setTimeout(() => {
      this.fire(this.options.onTimeout);
    }, this.options.timeoutMs);
    this.armStallTimer();
  }

  recordEvent(): void {
    if (this.stopped) return;
    this.armStallTimer();
  }

  stop(): void {
    this.stopped = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
  }

  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.fire(this.options.onStall);
    }, this.options.stallMs);
  }

  private fire(callback: () => void): void {
    if (this.stopped) return;
    this.stop();
    callback();
  }
}
