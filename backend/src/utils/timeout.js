export class TimeoutError extends Error {
  constructor(ms) {
    super(`Timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

// Rejects if the promise has not settled within ms. The timer is cleared as soon as either
// side finishes, so finished calls leave nothing behind.
export const withTimeout = (promise, ms) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};