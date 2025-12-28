import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../../../src/utilities/debounce";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays execution by specified ms", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on subsequent calls", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    debounced();
    vi.advanceTimersByTime(50);
    debounced(); // Reset timer
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled(); // Still waiting

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes arguments to wrapped function", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    debounced("arg1", 42);
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledWith("arg1", 42);
  });

  it("uses latest arguments when called multiple times", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    debounced("first");
    debounced("second");
    debounced("third");
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("cancel() prevents pending execution", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    debounced();
    vi.advanceTimersByTime(50);
    debounced.cancel();
    vi.advanceTimersByTime(100);

    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() is safe to call when no pending execution", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    // Should not throw
    expect(() => debounced.cancel()).not.toThrow();
  });

  it("can be called again after cancel()", () => {
    const fn = vi.fn();
    const debounced = debounce(100, fn);

    debounced("first");
    debounced.cancel();
    debounced("second");
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
  });
});
