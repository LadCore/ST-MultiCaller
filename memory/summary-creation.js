import { getSummaryScope, summarySourceKey } from './character-summary.js';
import { decodeMemoryRecord } from './memorybox-client.js';
import { sliceChatBeforeOffset } from '../agents/rp-context.js';

export const SUMMARY_CREATION_TYPE = 'summary-creation';
export const DEFAULT_SUMMARY_CREATION_PROMPT = `Create durable memories for {{user}}'s roleplay from the supplied recent messages.
The memory owner is the character described below. Write from that character's limited perspective, in first person and in the RP language. Preserve personality without inventing facts or knowledge.

Personality: {{characterPersonality}}
Scenario: {{characterScenario}}
Creator notes: {{characterCreatorNotes}}

Create one entry per distinct meaningful event, not one per message. Do not repeat the same event in multiple entries. Ignore filler without lasting significance. N1 is a compact bullet; N2 is a concise descriptive paragraph preserving the experience, decisions and relationships.
Importance: 1 routine useful event; 2 meaningful detail; 3 significant relationship, discovery or decision; 4 major turning point or lasting emotional impact; 5 life-defining event. Do not assign high importance merely because something is recent.
Return memories in chronological order. Do not generate message indices: code estimates their positions across the supplied message batch.
Current memories selected for the character (continuity reference, not new events):
{{characterSummary}}
Return JSON only, with this exact structure. Return an empty memories array when nothing merits storage.
{"memories":[{"title":"Short event name","bullet":"First-person N1","descriptive":"First-person N2","importance":1}]}

Recent messages:
{{recentChat}}`;

/** Validate only model-authored memory fields; scope, identity and registration keys come from code. */
export function parseSummaryCreation(output, allowedIndices) {
    let result;
    try { result = JSON.parse(output); }
    catch { throw new Error('Memory creation requires valid JSON.'); }
    if (!result || Array.isArray(result) || Object.keys(result).join() !== 'memories' || !Array.isArray(result.memories)) {
        throw new Error('Expected a JSON object containing only a memories array.');
    }
    const indices = [...allowedIndices];
    if (result.memories.length && !indices.length) throw new Error('Memory creation requires source messages.');
    const keys = ['bullet', 'descriptive', 'importance', 'title'];
    return result.memories.map((memory, index) => {
        if (!memory || Array.isArray(memory)
            || Object.keys(memory).filter(key => key !== 'last_relevant_message_index').sort().join() !== keys.join()
            || ['title', 'bullet', 'descriptive'].some(key => typeof memory[key] !== 'string' || !memory[key].trim())
            || memory.title.length > 240 || memory.bullet.length > 4000 || memory.descriptive.length > 20000
            || !Number.isInteger(memory.importance) || memory.importance < 1 || memory.importance > 5) {
            throw new Error(`Invalid memory ${index + 1}: expected title, bullet, descriptive and importance 1-5.`);
        }
        // Use each evenly sized segment's end; retain absolute chat indices despite hidden/tool gaps.
        const sourcePosition = Math.ceil((index + 1) * indices.length / result.memories.length) - 1;
        return { ...memory, title: memory.title.trim(), bullet: memory.bullet.trim(), descriptive: memory.descriptive.trim(),
            last_relevant_message_index: indices[sourcePosition] };
    });
}

/** Persist exact registration envelopes before network writes; retries never regenerate text or keys. */
export function createSummaryCreation({ getContext, getCharacter, selectMessages, onEvent = () => {}, fetchImpl = fetch }) {
    const active = new Set();
    const records = ctx => {
        ctx.chatMetadata.sceneDirector ??= {};
        return ctx.chatMetadata.sceneDirector.summaryCreation ??= {};
    };
    const scopeKey = character => summarySourceKey(character);
    const assertOrigin = (ctx, character, sourceKey, signal) => {
        signal?.throwIfAborted();
        const current = getContext();
        const live = getCharacter(character);
        if (current.chatMetadata !== ctx.chatMetadata || current.chatId !== ctx.chatId || current.groupId !== ctx.groupId
            || !live || scopeKey(live) !== sourceKey) throw new DOMException('Memory creation source or chat changed.', 'AbortError');
    };
    const persist = async (ctx, character, sourceKey, signal) => {
        assertOrigin(ctx, character, sourceKey, signal);
        if (!ctx.saveMetadata) throw new Error('Cannot persist the memory registration journal.');
        await ctx.saveMetadata();
        assertOrigin(ctx, character, sourceKey, signal);
    };

    function getState(agent, ctx = getContext()) {
        return ctx.chatMetadata?.sceneDirector?.summaryCreation?.[agent.id] ?? null;
    }

    function prepare(agent, ctx = getContext()) {
        const character = getCharacter(agent);
        if (!character) throw new Error('Memory creation has no character owner.');
        const scope = getSummaryScope(character);
        if (!scope.namespace || !scope.group_id) throw new Error('Configure the Summary namespace and group before creating memories.');
        if (Object.values(scope).some(value => value.length > 128) || String(ctx.chatId ?? ctx.groupId ?? '').length > 128) {
            throw new Error('Memory source names and chat IDs must fit the API limit of 128 characters.');
        }
        const sourceKey = scopeKey(character);
        const state = getState(agent, ctx);
        if (state?.pending) throw new Error('A memory save is pending. Use Retry Save before generating another batch.');
        const cursor = state?.sourceKey === sourceKey ? state.lastSavedIndex ?? 0 : 0;
        const messages = selectMessages(agent, { ...ctx, chat: sliceChatBeforeOffset(ctx.chat, agent.contextMessageOffset) });
        const indices = new Map(ctx.chat.map((message, index) => [message, index + 1]));
        const fresh = messages.filter(message => indices.get(message) > cursor);
        if (cursor && fresh.length > agent.contextMessages) {
            throw new Error(`There are ${fresh.length} unsummarized messages. Increase recent messages to avoid skipping the backlog.`);
        }
        const entries = fresh
            .slice(-agent.contextMessages).map(message => ({ index: indices.get(message), name: message.name,
                text: String(message.mes), message }));
        if (!entries.length) throw new Error('No new RP messages are available for memory creation.');
        return { sourceKey, scope, character: structuredClone(character), entries,
            throughIndex: entries.at(-1).index, sourceChatId: String(ctx.chatId ?? ctx.groupId ?? '') };
    }

    async function save(agent, output, input, ctx = getContext(), signal) {
        assertOrigin(ctx, input.character, input.sourceKey, signal);
        for (const entry of input.entries) {
            if (ctx.chat[entry.index - 1] !== entry.message || entry.message.mes !== entry.text) {
                throw new Error('Source messages changed during memory generation. Nothing was registered.');
            }
        }
        const memories = parseSummaryCreation(output, input.entries.map(entry => entry.index));
        const state = records(ctx)[agent.id] ??= {};
        if (state.pending) throw new Error('A memory registration batch is already pending.');
        const batchId = crypto.randomUUID();
        const referenceTime = new Date().toISOString();
        Object.assign(state, { sourceKey: input.sourceKey, pending: { output, throughIndex: input.throughIndex,
            scope: input.scope, bodies: memories.map((memory, index) => ({ ...input.scope, ...memory,
                registration_key: `backstage:${batchId}:${index}`, source_chat_id: input.sourceChatId,
                reference_time: referenceTime })), saved: [], error: '' } });
        return retry(agent, ctx, signal);
    }

    async function retry(agent, ctx = getContext(), signal) {
        const state = getState(agent, ctx);
        const pending = state?.pending;
        const character = getCharacter(agent);
        if (!pending || !character) throw new Error('There is no pending memory save.');
        if (active.has(agent.id)) throw new Error('This memory batch is already being saved.');
        const sourceKey = state.sourceKey;
        active.add(agent.id);
        try {
            await persist(ctx, character, sourceKey, signal);
            pending.error = '';
            for (let index = pending.saved.length; index < pending.bodies.length; index++) {
                assertOrigin(ctx, character, sourceKey, signal);
                const body = pending.bodies[index];
                onEvent({ stage: 'registration-request', agentId: agent.id, index, request: body });
                const response = await fetchImpl('http://127.0.0.1:8091/memorybox/nodes', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
                });
                if (!response.ok) throw new Error(`Memory registration HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
                const result = await response.json();
                if (result.meta?.partial || result.results?.length !== 1) throw new Error('Memory registration returned an incomplete result.');
                const memory = decodeMemoryRecord(result.results[0]);
                if (memory.importance !== body.importance || memory.last_relevant_message_index !== body.last_relevant_message_index) {
                    throw new Error('Memory registration returned different source properties. Retry the original save to reconcile.');
                }
                assertOrigin(ctx, character, sourceKey, signal);
                pending.saved.push(memory);
                onEvent({ stage: 'registration-saved', agentId: agent.id, index, memory });
                await persist(ctx, character, sourceKey, signal);
            }
            const saved = [...pending.saved];
            state.lastSavedIndex = pending.throughIndex;
            state.lastBatch = { savedAt: new Date().toISOString(), count: saved.length, throughIndex: pending.throughIndex };
            delete state.pending;
            try { await persist(ctx, character, sourceKey, signal); }
            catch (error) { state.pending = pending; throw error; }
            return { saved, output: pending.output };
        } catch (error) {
            pending.error = error.message;
            // The pre-write envelope remains available for explicit reconciliation, including uncertain writes.
            if (getContext().chatMetadata === ctx.chatMetadata) {
                try { await ctx.saveMetadata?.(); } catch { /* Keep the original registration failure. */ }
            }
            throw error;
        } finally { active.delete(agent.id); }
    }

    return { prepare, save, retry, getState };
}
