const USAGE_URL = 'http://127.0.0.1:8091/usage/check';
const VERDICTS = new Set(['used', 'same_topic', 'contradicted', 'not_used']);

/** Diagnostic only: send one N2 and the exact selected replies, without truncation or rating writes. */
export async function checkSummaryMemoryUsage(reference, messages, { signal, fetchImpl = fetch } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 130000);
    try {
        const response = await fetchImpl(USAGE_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reference, messages }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Usage HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
        const result = await response.json();
        if (!VERDICTS.has(result.verdict) || !Number.isFinite(result.usage_probability)
            || !Number.isFinite(result.confidence) || result.usage_probability < 0 || result.usage_probability > 1
            || result.confidence < 0 || result.confidence > 1 || result.evaluated_messages !== messages.length) {
            throw new Error('Invalid usage-check response.');
        }
        return result;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}
