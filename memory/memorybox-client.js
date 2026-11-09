const API_URL = 'http://127.0.0.1:8091';

/** Exclude balanced single-asterisk RP actions, preserving escaped stars and Markdown bold. */
export function prepareSemanticQuery(text) {
    return String(text ?? '').replace(/(?<![\\*])\*(?!\*)(?:\\[\s\S]|[^\\*])*\*(?!\*)/g, ' ')
        .replace(/[ \t]{2,}/g, ' ').trim();
}

async function request(path, body, { method = 'POST', signal, fetchImpl = fetch } = {}) {
    const timeout = AbortSignal.timeout(60000);
    const response = await fetchImpl(`${API_URL}${path}`, {
        method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/json' }, ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`MemoryBox ${method} HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
    return response.json();
}

/** Decode only scoped episode records, not fact UUIDs returned by semantic retrieval. */
export function decodeMemoryRecord(record) {
    if (!record || record.kind !== 'memory' || !record.id) throw new Error('MemoryBox did not return a memory episode.');
    const text = [...new Set((record.references?.n2 ?? []).map(reference => String(reference.text ?? '').trim()).filter(Boolean))].join('\n\n');
    if (!text) throw new Error(`Memory ${record.id} has no N2.`);
    return { id: record.id, text, importance: record.importance ?? null,
        last_relevant_message_index: record.last_relevant_message_index ?? null, boost: record.boost ?? null };
}

function decodeSingle(response, id) {
    if (!Array.isArray(response?.results) || response.meta?.partial || response.results.length !== 1) {
        throw new Error('Incomplete MemoryBox episode response.');
    }
    const memory = decodeMemoryRecord(response.results[0]);
    if (memory.id !== id) throw new Error('MemoryBox returned a different episode UUID.');
    return memory;
}

/** Retrieve native fact matches grouped by source-memory ID, without a usage classifier or writes. */
export async function findSemanticCandidates(scope, query, limit, { minSimilarity = null, ...options } = {}) {
    const body = { ...scope, query, limit };
    if (minSimilarity != null) body.min_similarity = minSimilarity;
    const response = await request('/memorybox/semantic-candidates', body, options);
    if (!Array.isArray(response)) throw new Error('Expected a semantic-candidates root array.');
    const candidates = new Map();
    for (const item of response) {
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.n1 !== 'string'
            || !Array.isArray(item.matches) || !item.matches.length
            || item.matches.some(match => !match || typeof match.fact_id !== 'string' || !match.fact_id
                || !Number.isFinite(match.similarity))) {
            throw new Error('Invalid semantic memory candidate.');
        }
        const previous = candidates.get(item.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Conflicting semantic memory candidates.');
        candidates.set(item.id, item);
    }
    // The API limit bounds facts, not source-memory IDs. Do not truncate their sources again.
    return { candidates: [...candidates.values()], found: candidates.size };
}

export async function readScopedMemory(scope, id, options = {}) {
    const query = new URLSearchParams(scope);
    return decodeSingle(await request(`/memorybox/nodes/${encodeURIComponent(id)}?${query}`, null,
        { ...options, method: 'GET' }), id);
}

/** PATCH is never retried automatically: a lost response does not prove a failed write. */
export async function patchMemoryBoost(scope, id, boost, options = {}) {
    const result = decodeSingle(await request(`/memorybox/nodes/${encodeURIComponent(id)}`,
        { ...scope, boost }, { ...options, method: 'PATCH' }), id);
    if (result.boost?.message_index !== boost.message_index || !Number.isFinite(result.boost.value)
        || Math.abs(result.boost.value - boost.value) > 1e-12) throw new Error('PATCH returned an unconfirmed boost.');
    return result;
}
