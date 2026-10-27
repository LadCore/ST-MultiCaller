import { normalizeAgentInjectionPlacement } from '../agents/character-injection.js';
import { evaluateSummaryMemories, normalizeSummaryHalfLives } from './summary-rating.js';
import { normalizeReinforcementConfig } from './reinforcement-policy.js';

const API_URL = 'http://127.0.0.1:8091';
const PAGE_SIZE = 250;

/** Normalize persisted source settings and reuse the native agent placement contract. */
export function normalizeSummaryConfig(value = {}) {
    const rating = Number(value.minRating);
    const placement = normalizeAgentInjectionPlacement(value);
    return {
        namespace: String(value.namespace ?? '').trim(),
        groupId: String(value.groupId ?? '').trim(),
        minRating: Number.isFinite(rating) ? rating : 0,
        halfLives: normalizeSummaryHalfLives(value.halfLives),
        reinforcement: normalizeReinforcementConfig(value.reinforcement),
        enabled: value.enabled === true,
        characterInjectionPosition: placement.position,
        characterInjectionDepth: placement.depth,
        characterInjectionRole: placement.role,
    };
}

export function getSummaryScope(character) {
    const settings = normalizeSummaryConfig(character?.summary);
    return { namespace: settings.namespace, group_id: settings.groupId, character: character.name };
}

export function summarySourceKey(character) {
    return JSON.stringify(getSummaryScope(character));
}

export function getCharacterSummary(ctx, character) {
    const stored = ctx.chatMetadata?.sceneDirector?.characterSummaries?.[character.avatar || character.name];
    if (!stored) return null;
    const needsRefresh = !Array.isArray(stored.allMemories);
    const candidates = needsRefresh ? stored.memories ?? [] : stored.allMemories;
    return {
        ...stored,
        ...evaluateSummaryMemories(candidates, ctx.chat?.length ?? 0, normalizeSummaryConfig(character.summary)),
        needsRefresh,
    };
}

/** Persist source IDs alongside clean N2 text, isolated to this chat and character. */
export function saveCharacterSummary(ctx, character, result) {
    ctx.chatMetadata.sceneDirector ??= {};
    ctx.chatMetadata.sceneDirector.characterSummaries ??= {};
    ctx.chatMetadata.sceneDirector.characterSummaries[character.avatar || character.name] = {
        ...result, sourceKey: summarySourceKey(character), updatedAt: new Date().toISOString(),
    };
    ctx.saveMetadata?.();
}

/** Read all rating pages; failures never return a partial replacement summary. */
export async function fetchCharacterSummary(character, { fetchImpl = fetch, signal, currentMessageIndex = 0 } = {}) {
    const scope = getSummaryScope(character);
    if (!scope.namespace || !scope.group_id || !scope.character) throw new Error('Namespace, group and character are required.');
    const memories = new Map();
    const offsets = new Set();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 60000);
    try {
        let offset = 0;
        do {
            if (offsets.has(offset)) throw new Error('MemoryBox returned a repeated page offset.');
            offsets.add(offset);
            const response = await fetchImpl(`${API_URL}/memorybox/by-rating`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...scope, limit: PAGE_SIZE, offset }), signal: controller.signal,
            });
            if (!response.ok) throw new Error(`MemoryBox HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
            const page = await response.json();
            if (!Array.isArray(page.results) || !page.meta || !Object.hasOwn(page.meta, 'next_offset')
                || page.meta.partial || page.meta.warnings?.length) {
                throw new Error(`Incomplete MemoryBox response: ${JSON.stringify(page.meta ?? {}).slice(0, 500)}`);
            }
            for (const record of page.results) {
                if (record.kind !== 'memory' || !record.id) throw new Error('Invalid memory in MemoryBox response.');
                const text = (Array.isArray(record.references?.n2) ? record.references.n2 : [])
                    .map(reference => String(reference.text ?? '').trim()).filter(Boolean).join('\n\n');
                if (!text) throw new Error(`Memory ${record.id} has no N2 text.`);
                memories.set(record.id, {
                    id: record.id, text, importance: record.importance ?? null,
                    last_relevant_message_index: record.last_relevant_message_index ?? null,
                    boost: record.boost ?? null,
                });
            }
            const next = page.meta.next_offset;
            if (next != null && (!Number.isInteger(next) || next <= offset)) throw new Error('Invalid MemoryBox pagination.');
            offset = next ?? null;
        } while (offset !== null);
        return evaluateSummaryMemories([...memories.values()], currentMessageIndex, normalizeSummaryConfig(character.summary));
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}

/** Adapt the cached summary to the same placement pipeline as agent outputs. */
export function buildSummaryInjection(ctx, character) {
    const settings = normalizeSummaryConfig(character?.summary);
    const summary = getCharacterSummary(ctx, character);
    if (!settings.enabled || !summary?.text || summary.needsRefresh || summary.sourceKey !== summarySourceKey(character)) return null;
    return {
        agent: { id: `memorybox-${character.avatar || character.name}`, ...settings },
        prompt: `<Summary>\n${summary.text}\n</Summary>`,
        deliveries: [],
    };
}
