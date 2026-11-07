/**
 * Nothing the app waits on may wait for ever without saying so. A wallet
 * request in particular has no timeout of its own: dismiss MetaMask's window,
 * or lose it behind a full-screen browser, and the promise simply never
 * settles. That froze a CCIP transfer during a demo — nothing broadcast, no
 * error, a dialog with every exit disabled.
 */

/** How long a read may hold up a transaction before it is reported as failed. */
export const READ_TIMEOUT_MS = 30_000;

/** How long a wallet may stay silent before the screen says so and offers a way out. */
export const WALLET_STALL_MS = 15_000;

/** Rejects with `message` if `work` has not settled in `ms`. The work itself is not cancelled. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
