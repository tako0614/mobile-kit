import { createSignal } from "solid-js";

/**
 * Guarded manual retry for the controller's initial start. At most one
 * attempt is ever in flight (a second call while running is a no-op that
 * rides the single in-flight operation), there is no timer-driven retry,
 * and disposal keeps a late completion from writing state. The attempt
 * itself is always safe to offer: the controller's own cleanup custody
 * refuses before it could hold two live registrations.
 */
export function createStartupRetry(run: () => Promise<unknown>) {
  const [failed, setFailed] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  let disposed = false;

  async function attempt(): Promise<void> {
    if (disposed || starting()) return;
    setStarting(true);
    try {
      await run();
      if (!disposed) setFailed(false);
    } catch (error) {
      // The rejection stays off the unhandled path, but it must still
      // leave a diagnostic trace — the UI only renders generic copy.
      console.error("mobile client start failed", error);
      if (!disposed) setFailed(true);
    } finally {
      setStarting(false);
    }
  }

  function dispose(): void {
    disposed = true;
  }

  return { failed, starting, attempt, dispose };
}
