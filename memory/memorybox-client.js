const API_URL = 'http://127.0.0.1:8091';

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

/** Search all scoped memories, independently of the current box cutoff. */
export async function findReinforcementCandidates(scope, query, limit, options = {}) {
    const response = await request('/memorybox/query', { ...scope, query, limit }, options);
    if (!Array.isArray(response?.results) || !response.meta || response.meta.partial) {
        throw new Error('Incomplete MemoryBox semantic response.');
    }
    const candidates = new Map();
    for (const fact of response.results) {
        for (const reference of fact.references?.n2 ?? []) {
            if (!reference.id || !String(reference.text ?? '').trim()) throw new Error('Invalid semantic N2 reference.');
            if (!candidates.has(reference.id)) candidates.set(reference.id, {
                id: reference.id, text: reference.text, importance: reference.importance ?? null,
                last_relevant_message_index: reference.last_relevant_message_index ?? null, boost: reference.boost ?? null,
            });
        }
    }
    return { candidates: [...candidates.values()].slice(0, limit), found: candidates.size, meta: response.meta };
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
