// Session-cache an async source as a memoized promise: dedupes in-flight
// calls, caches success for the session, and RESETS on rejection so the next
// call is a genuine retry. (React.lazy caches a rejected import forever —
// the footgun this exists to avoid.)

export interface OnceSource<T> {
  (): Promise<T>;
  /** Sync read of the cached success value — null until first resolution. */
  peek(): T | null;
}

export function once<T>(fetcher: () => Promise<T>): OnceSource<T> {
  let promise: Promise<T> | null = null;
  let value: T | null = null;
  const source = (() => {
    if (!promise) {
      promise = fetcher().then(
        (v) => {
          value = v;
          return v;
        },
        (err: unknown) => {
          promise = null;
          throw err;
        },
      );
    }
    return promise;
  }) as OnceSource<T>;
  source.peek = () => value;
  return source;
}
