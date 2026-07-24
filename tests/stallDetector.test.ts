import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StallDetector } from "../src/daemon/stallDetector.js";

describe("StallDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onStall when no events arrive within stallMs", () => {
    const onStall = vi.fn();
    const onTimeout = vi.fn();
    const detector = new StallDetector({
      stallMs: 1000,
      timeoutMs: 60000,
      onStall,
      onTimeout,
    });
    detector.start();
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not stall while events keep arriving", () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallMs: 1000,
      timeoutMs: 60000,
      onStall,
      onTimeout: vi.fn(),
    });
    detector.start();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(900);
      detector.recordEvent();
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires onTimeout at the wall clock limit even with steady events", () => {
    const onStall = vi.fn();
    const onTimeout = vi.fn();
    const detector = new StallDetector({
      stallMs: 1000,
      timeoutMs: 5000,
      onStall,
      onTimeout,
    });
    detector.start();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(900);
      detector.recordEvent();
    }
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires nothing after stop", () => {
    const onStall = vi.fn();
    const onTimeout = vi.fn();
    const detector = new StallDetector({
      stallMs: 1000,
      timeoutMs: 2000,
      onStall,
      onTimeout,
    });
    detector.start();
    detector.stop();
    vi.advanceTimersByTime(10000);
    expect(onStall).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("fires each callback at most once", () => {
    const onStall = vi.fn();
    const onTimeout = vi.fn();
    const detector = new StallDetector({
      stallMs: 1000,
      timeoutMs: 1500,
      onStall,
      onTimeout,
    });
    detector.start();
    vi.advanceTimersByTime(10000);
    expect(onStall.mock.calls.length + onTimeout.mock.calls.length).toBe(1);
  });
});
