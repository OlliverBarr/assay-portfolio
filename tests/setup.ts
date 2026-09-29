/**
 * Vitest global setup: polyfill Promise.withResolvers for runtimes older
 * than Node 22. The executor form is required here and only here — all
 * other code uses Promise.withResolvers().
 */
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
