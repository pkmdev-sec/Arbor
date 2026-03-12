/**
 * lib/retry.mjs — Generic retry with exponential backoff
 *
 * Extracted from agent-entry.mjs retry loop for independent testability.
 */

/**
 * Retry an async function with exponential backoff.
 *
 * @param {Object} opts
 * @param {() => Promise<any>} opts.fn          — async function to retry
 * @param {number} [opts.maxRetries=0]          — maximum number of retries (0 = no retries)
 * @param {(error: any) => Promise<{shouldRetry: boolean}>|{shouldRetry: boolean}} [opts.classifier]
 *   — optional async/sync error classifier. Returns { shouldRetry } to control retry behavior.
 *     If omitted, all errors trigger retry.
 * @param {(retryCount: number, error: any, backoffMs: number) => void} [opts.onRetry]
 *   — optional callback invoked before each retry wait
 * @param {number} [opts.baseDelay=1000]        — base delay in ms (doubles each retry: 1s, 2s, 4s)
 * @param {(budget: number) => boolean} [opts.budgetCheck]
 *   — optional function to check if budget is sufficient for retry
 * @returns {Promise<{result: any, retryCount: number}>}
 * @throws Last error if all retries exhausted
 */
export async function retryWithBackoff({
  fn,
  maxRetries = 0,
  classifier,
  onRetry,
  baseDelay = 1000,
  budgetCheck,
}) {
  let lastError;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const result = await fn(retryCount);
      return { result, retryCount };
    } catch (error) {
      lastError = error;

      // No more retries available
      if (retryCount >= maxRetries) {
        break;
      }

      // Budget check
      if (budgetCheck && !budgetCheck(retryCount + 1)) {
        break;
      }

      // Classify error if classifier is provided
      if (classifier) {
        const classification = await classifier(error);
        if (!classification.shouldRetry) {
          break;
        }
      }

      retryCount++;

      // Calculate backoff: baseDelay * 2^(retryCount-1)
      const backoffMs = baseDelay * Math.pow(2, retryCount - 1);

      // Notify caller about retry
      if (onRetry) {
        onRetry(retryCount, lastError, backoffMs);
      }

      // Wait with exponential backoff
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  // All retries exhausted or classified as non-retryable
  const err = lastError || new Error("retryWithBackoff: no attempts made");
  err.retryCount = retryCount;
  throw err;
}

/**
 * Compute exponential backoff delay in milliseconds.
 *
 * @param {number} retryCount — 1-indexed retry number
 * @param {number} [baseDelay=1000] — base delay in ms
 * @returns {number} delay in ms
 */
export function computeBackoff(retryCount, baseDelay = 1000) {
  return baseDelay * Math.pow(2, retryCount - 1);
}
