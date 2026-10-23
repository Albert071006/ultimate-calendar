/** Main owns one runner shared by manual workflows and QQ background analysis. */
export type ModelRequestRunner = <T>(work: () => Promise<T>) => Promise<T>;

export function createModelRequestQueue(): { run: ModelRequestRunner; busy(): boolean; pending(): number } {
  let tail: Promise<void> = Promise.resolve();
  let waiting = 0;
  let active = false;
  const run: ModelRequestRunner = <T>(work: () => Promise<T>): Promise<T> => {
    waiting++;
    const next = tail.then(async () => {
      waiting--; active = true;
      try { return await work(); }
      finally { active = false; }
    });
    // A failed job releases the queue without changing its caller's rejection.
    tail = next.then(() => {}, () => {});
    return next;
  };
  return { run, busy: () => active || waiting > 0, pending: () => waiting };
}
