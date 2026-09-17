// Classification and accounting helpers for Anthropic API calls. Pure: no database, no network.
//
// An Anthropic failure used to be logged as a bare "HTTP 400", which is how an exhausted credit
// balance stopped every headline rewrite for ninety minutes without anything saying why. The body
// says why, so it is read and classified.

export const MODEL_PRICES_PER_MTOK = {
  // First-party API rates, USD per million tokens. Cache writes are the 5-minute TTL rate.
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

// Failure classes. The first group means no call can succeed until someone acts; the second is
// expected to clear on its own.
export const BLOCKING_CLASSES = new Set(['insufficient_credits', 'authentication', 'permission']);
export const TRANSIENT_CLASSES = new Set(['rate_limit', 'overloaded', 'server_error', 'timeout', 'network']);

/**
 * @param {{ status?: number, body?: any, error?: any }} f  HTTP status and parsed error body, or a thrown error
 * @returns {string} one of insufficient_credits, authentication, permission, rate_limit, overloaded,
 *   server_error, timeout, network, not_found, invalid_request, unknown
 */
export function classifyAnthropicFailure({ status = 0, body = null, error = null } = {}) {
  if (error) {
    const name = String(error?.name || '');
    const code = String(error?.cause?.code || error?.code || '');
    if (name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(code)) return 'timeout';
    return 'network';
  }
  const type = String(body?.error?.type || '');
  const message = String(body?.error?.message || '');
  if (/credit balance|purchase credits|billing/i.test(message)) return 'insufficient_credits';
  if (status === 401 || type === 'authentication_error') return 'authentication';
  if (status === 403 || type === 'permission_error') return 'permission';
  if (status === 429 || type === 'rate_limit_error') return 'rate_limit';
  if (status === 529 || type === 'overloaded_error') return 'overloaded';
  if (status === 404 || type === 'not_found_error') return 'not_found';
  if (status === 408 || status === 504 || type === 'timeout_error') return 'timeout';
  if (status >= 500 || type === 'api_error') return 'server_error';
  if (status === 400 || type === 'invalid_request_error') return 'invalid_request';
  return 'unknown';
}

/** Token counts from a Messages API response body; null fields when absent. */
export function usageOf(data) {
  const u = data?.usage || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_read_tokens: n(u.cache_read_input_tokens),
    cache_write_tokens: n(u.cache_creation_input_tokens),
  };
}

/** Cost in USD of one call's usage, or null for an unknown model. */
export function costOf(model, usage) {
  const p = MODEL_PRICES_PER_MTOK[model];
  if (!p || !usage) return null;
  const t = (v) => Number(v) || 0;
  return (t(usage.input_tokens) * p.input + t(usage.output_tokens) * p.output
    + t(usage.cache_read_tokens) * p.cacheRead + t(usage.cache_write_tokens) * p.cacheWrite) / 1e6;
}

/** A short, log-safe description. Never includes request content or credentials. */
export function describeFailure(errorClass, status, message) {
  const m = String(message || '').replace(/\s+/g, ' ').slice(0, 160);
  // Already described (it passed through here once): keep it as is rather than prefixing it twice.
  if (errorClass && m.startsWith(`${errorClass} (HTTP`) || m.startsWith(`${errorClass}:`)) return m;
  return `${errorClass}${status ? ` (HTTP ${status})` : ''}${m ? `: ${m}` : ''}`;
}
