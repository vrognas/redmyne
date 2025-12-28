/**
 * Debounced function type with cancel method
 */
export type DebouncedFunction<T extends (...args: never[]) => void> = T & {
  cancel: () => void;
};

/**
 * Create a debounced version of a function
 *
 * The debounced function delays execution until `ms` milliseconds have passed
 * since the last call. Each call resets the timer.
 *
 * @param ms - Delay in milliseconds
 * @param fn - Function to debounce
 * @returns Debounced function with cancel() method
 *
 * @example
 * const debouncedRefresh = debounce(300, () => tree.refresh());
 * debouncedRefresh(); // Called multiple times...
 * debouncedRefresh(); // ...only executes once after 300ms
 * debouncedRefresh.cancel(); // Cancel pending execution
 */
export function debounce<T extends (...args: never[]) => void>(
  ms: number,
  fn: T
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as DebouncedFunction<T>;

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return debounced;
}
