export async function retry<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= retries) {
        throw err;
      }
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  // todo: if we are here, it's a bug, catch it and notify
  throw new Error("Retry failed unexpectedly.");
}
