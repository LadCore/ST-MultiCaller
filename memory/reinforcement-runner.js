import { getCharacterSummary, getSummaryScope, normalizeSummaryConfig, summarySourceKey } from './character-summary.js';
import { calculateSummaryRating } from './summary-rating.js';
import { planMemoryBoost } from './reinforcement-policy.js';
import { findSemanticCandidates, patchMemoryBoost, prepareSemanticQuery, readScopedMemory } from './memorybox-client.js';
import { setSideBox, clearSideBox } from './side-box-state.js';

/** Capture every RP message after the character's last valid reply, preserving full-chat indices. */
export function collectCharacterInterval(chat, character, isExcluded = () => false) {
    const entries = [];
    let previousIndex = 0;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_system || !String(message.mes ?? '').trim()
            || ['tool_call', 'tool_response'].includes(message.extra?.type)
            || message.extra?.tool_invocations?.length || isExcluded(message)) continue;
        const ownReply = !message.is_user && (message.original_avatar && character.avatar
            ? message.original_avatar === character.avatar : message.name === character.name);
        if (ownReply) { previousIndex = index + 1; break; }
        entries.push({ index: index + 1, role: message.is_user ? 'user' : 'assistant',
            name: String(message.name ?? ''), content: String(message.mes) });
    }
    entries.reverse();
    return { previousIndex, messageIndex: chat.length, entries,
        messages: entries.map(({ role, name, content }) => ({ role, name, content })) };
}

/** Retrieve temporary Side memories before a turn; reinforce only matching IDs after its final reply. */
export function createMemoryReinforcement({
    getContext, getCharacters, onEvent = () => {}, isOocMessage = () => false,
    findCandidates = findSemanticCandidates, readMemory = readScopedMemory, patchBoost = patchMemoryBoost,
}) {
    const chats = new WeakMap();
    const ignored = new WeakSet();
    const statesFor = ctx => {
        if (!chats.has(ctx.chatMetadata)) chats.set(ctx.chatMetadata, new Map());
        return chats.get(ctx.chatMetadata);
    };
    const lookup = character => getCharacters().find(item => character.avatar
        ? item.avatar === character.avatar : item.name === character.name);
    const excluded = message => ignored.has(message) || isOocMessage(message.mes);
    const collect = (ctx, character, end = ctx.chat.length) => collectCharacterInterval(ctx.chat.slice(0, end), character, excluded);

    function emit(job, stage, data = {}, level = 'info') {
        onEvent({ runId: job.runId, character: job.character.name, scope: job.scope,
            message_index: job.replyIndex ?? job.messageIndex, at: new Date().toISOString(), stage, level, ...data });
    }

    function assertCurrent(job, reply = null) {
        job.controller.signal.throwIfAborted();
        const ctx = getContext();
        const live = lookup(job.character);
        if (ctx.chatMetadata !== job.ctx.chatMetadata || ctx.chatId !== job.ctx.chatId || ctx.groupId !== job.ctx.groupId
            || statesFor(job.ctx).get(job.sourceKey) !== job || !live
            || JSON.stringify(normalizeSummaryConfig(live.summary)) !== JSON.stringify(job.settings)
            || JSON.stringify(collect(ctx, live, job.messageIndex)) !== job.intervalSnapshot
            || (!reply && ctx.chat.length !== job.messageIndex)
            || (reply && (ctx.chat.at(-1) !== reply || reply.mes !== job.replyText || ignored.has(reply)))) {
            throw new DOMException('SideBox stopped: chat, source, settings or source messages changed.', 'AbortError');
        }
    }

    function clear(job) {
        // An obsolete job must never clear a newer turn's SideBox.
        if (statesFor(job.ctx).get(job.sourceKey) !== job) return;
        clearSideBox(job.ctx, job.sourceKey);
        job.stage = 'idle';
        job.side = [];
        job.detachSignal?.();
    }

    async function search(job, query, phase, reply = null) {
        assertCurrent(job, reply);
        const policy = job.settings.reinforcement;
        emit(job, 'search-request', { phase, request: { ...job.scope, query, limit: policy.candidateLimit,
            ...(policy.minSimilarity == null ? {} : { min_similarity: policy.minSimilarity }) } });
        const result = await findCandidates(job.scope, query, policy.candidateLimit,
            { signal: job.controller.signal, minSimilarity: policy.minSimilarity });
        assertCurrent(job, reply);
        emit(job, 'search-result', { ...result, phase });
        return result.candidates;
    }

    async function prepare(job) {
        emit(job, 'start', { phase: 'before', context: { scope: job.scope, query: job.text,
            messages: job.interval.messages, previousCharacterMessageIndex: job.interval.previousIndex,
            throughMessageIndex: job.messageIndex }, settings: job.settings });
        try {
            const summary = getCharacterSummary(job.ctx, job.character);
            if (!summary || summary.needsRefresh || summary.sourceKey !== job.sourceKey) {
                throw new Error('Update the character summary before using SideBox.');
            }
            const inIds = new Set(summary.memories.map(memory => memory.id));
            const candidates = await search(job, job.text, 'before');
            const unique = [...new Map(candidates.filter(item => !inIds.has(item.id)).map(item => [item.id, item])).values()];
            const results = await Promise.allSettled(unique.map(async candidate => {
                const memory = await readMemory(job.scope, candidate.id, { signal: job.controller.signal });
                assertCurrent(job);
                const calculated = calculateSummaryRating(memory, job.messageIndex, job.settings.halfLives);
                if (calculated.rating == null || calculated.rating >= job.settings.minRating) return null;
                return { ...memory, ...calculated, matches: candidate.matches ?? [] };
            }));
            assertCurrent(job);
            job.side = results.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value);
            const failures = results.filter(item => item.status === 'rejected');
            if (failures.length) job.lastError = failures.map(item => item.reason.message).join(' | ');
            setSideBox(job.ctx, job.sourceKey, job.side);
            job.stage = 'waiting';
            emit(job, 'side-ready', { memories: job.side, inCount: inIds.size, sideCount: job.side.length,
                inMemoryIds: [...inIds],
                failedCount: failures.length, error: job.lastError }, failures.length ? 'warn' : 'info');
            emit(job, 'finish', { phase: 'before', status: failures.length ? 'error' : 'success', error: job.lastError });
            return { status: 'ready' };
        } catch (error) {
            job.lastError = error.message;
            clear(job);
            const status = error.name === 'AbortError' ? 'stopped' : 'error';
            emit(job, 'finish', { phase: 'before', status, error: error.message }, status === 'error' ? 'error' : 'warn');
            return { status, error: error.message };
        }
    }

    async function beforeCharacter(character, { signal } = {}) {
        const ctx = getContext();
        character = lookup(character);
        if (!character) return;
        const settings = normalizeSummaryConfig(character.summary);
        const sourceKey = summarySourceKey(character);
        const existing = statesFor(ctx).get(sourceKey);
        const interval = collect(ctx, character);
        const intervalSnapshot = JSON.stringify(interval);
        if (existing && ['preparing', 'waiting'].includes(existing.stage)
            && existing.ctx.chatId === ctx.chatId && existing.ctx.groupId === ctx.groupId
            && !existing.controller.signal.aborted && existing.intervalSnapshot === intervalSnapshot
            && JSON.stringify(existing.settings) === JSON.stringify(settings)) return existing.beforeTask;
        stop(character);
        const text = interval.messages.map(message => ({ ...message, content: prepareSemanticQuery(message.content) }))
            .filter(message => message.content).map(message => `${message.name}: ${message.content}`).join('\n\n');
        if (!settings.enabled || !settings.reinforcement.enabled || !settings.namespace || !settings.groupId
            || !text) return;
        const job = { ctx, character: structuredClone(character), scope: getSummaryScope(character), sourceKey,
            interval, intervalSnapshot, settings, messageIndex: interval.messageIndex,
            text,
            controller: new AbortController(), side: [], lastError: '', stage: 'preparing',
            runId: `side-before-${crypto.randomUUID()}` };
        statesFor(ctx).set(sourceKey, job);
        if (signal) {
            const abort = () => { job.controller.abort(); clear(job); };
            signal.addEventListener('abort', abort, { once: true });
            job.detachSignal = () => signal.removeEventListener('abort', abort);
            if (signal.aborted) abort();
        }
        job.beforeTask = prepare(job);
        return job.beforeTask;
    }

    function updateCache(job, memory) {
        const cache = job.ctx.chatMetadata.sceneDirector?.characterSummaries?.[job.character.avatar || job.character.name];
        if (cache?.sourceKey !== job.sourceKey || !Array.isArray(cache.allMemories)) return;
        const previous = cache.allMemories.find(item => item.id === memory.id);
        if (previous) Object.assign(previous, memory);
        else cache.allMemories.push(memory);
    }

    async function reinforce(job, memory, match, reply) {
        assertCurrent(job, reply);
        const fresh = await readMemory(job.scope, memory.id, { signal: job.controller.signal });
        assertCurrent(job, reply);
        if (fresh.text !== memory.text) return { memoryId: memory.id, action: 'skipped', reason: 'N2 changed after injection.' };
        const plan = planMemoryBoost(fresh, job.replyIndex, job.settings);
        emit(job, 'boost-calculation', { memoryId: memory.id, cutoff: job.settings.minRating, plan });
        if (!plan.apply) return { memoryId: memory.id, action: 'skipped', ...plan };
        emit(job, 'patch-request', { memoryId: memory.id, request: { ...job.scope, id: memory.id, boost: plan.boost } });
        let confirmed;
        try {
            confirmed = await patchBoost(job.scope, memory.id, plan.boost, { signal: job.controller.signal });
        } catch (error) {
            emit(job, 'patch-unconfirmed', { memoryId: memory.id, error: error.message, retry: false }, 'error');
            assertCurrent(job, reply);
            confirmed = await readMemory(job.scope, memory.id, { signal: job.controller.signal });
            if (confirmed.boost?.message_index !== plan.boost.message_index
                || !Number.isFinite(confirmed.boost?.value) || Math.abs(confirmed.boost.value - plan.boost.value) > 1e-12) throw error;
        }
        assertCurrent(job, reply);
        if (confirmed.text !== fresh.text || confirmed.importance !== fresh.importance
            || confirmed.last_relevant_message_index !== fresh.last_relevant_message_index) {
            throw new Error('Memory source changed while saving its boost.');
        }
        updateCache(job, confirmed);
        emit(job, 'patch-confirmed', { memoryId: memory.id, memory: confirmed, matches: match.matches, target: plan.target });
        const rating = calculateSummaryRating(confirmed, job.replyIndex, job.settings.halfLives).rating;
        return { memoryId: memory.id, action: 'boosted', boost: confirmed.boost,
            fromBox: 'Side', toBox: rating != null && rating >= job.settings.minRating ? 'In' : 'Out', rating };
    }

    async function finish(job, reply) {
        job.runId = `side-after-${crypto.randomUUID()}`;
        job.stage = 'comparing';
        job.lastError = '';
        let status = 'success';
        emit(job, 'start', { phase: 'after', context: { response: job.replyText,
            sideIds: job.side.map(memory => memory.id), sideMemories: job.side } });
        try {
            const query = prepareSemanticQuery(job.replyText);
            if (!job.side.length) return { status: 'success' };
            if (!query) {
                for (const memory of job.side) emit(job, 'side-discarded', {
                    memoryId: memory.id, reason: 'No text outside actions; search skipped.' });
                return { status: 'success' };
            }
            const candidates = await search(job, query, 'after', reply);
            const matches = new Map(candidates.map(candidate => [candidate.id, candidate]));
            const outcomes = [];
            for (const memory of job.side) {
                assertCurrent(job, reply);
                const match = matches.get(memory.id);
                if (!match) {
                    emit(job, 'side-discarded', { memoryId: memory.id });
                    continue;
                }
                emit(job, 'side-match', { memoryId: memory.id, text: memory.text,
                    beforeMatches: memory.matches, matches: match.matches });
                try {
                    const outcome = await reinforce(job, memory, match, reply);
                    outcomes.push(outcome);
                    emit(job, 'candidate-complete', outcome);
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    outcomes.push({ memoryId: memory.id, action: 'error', error: error.message });
                    emit(job, 'candidate-error', outcomes.at(-1), 'error');
                }
            }
            assertCurrent(job, reply);
            await job.ctx.saveMetadata?.();
            assertCurrent(job, reply);
            job.lastError = outcomes.filter(item => item.action === 'error').map(item => item.error).join(' | ');
            status = job.lastError ? 'error' : 'success';
            return { status, error: job.lastError };
        } catch (error) {
            job.lastError = error.message;
            status = error.name === 'AbortError' ? 'stopped' : 'error';
            return { status, error: error.message };
        } finally {
            clear(job);
            emit(job, 'finish', { phase: 'after', status, error: job.lastError }, status === 'error' ? 'error' : status === 'stopped' ? 'warn' : 'info');
        }
    }

    async function afterCharacter(reply) {
        const ctx = getContext();
        if (!reply || ctx.chat.at(-1) !== reply || reply.is_user || reply.is_system || excluded(reply)
            || !String(reply.mes ?? '').trim() || reply.extra?.tool_invocations?.length
            || ['tool_call', 'tool_response'].includes(reply.extra?.type)) return;
        const character = getCharacters().find(item => reply.original_avatar
            ? reply.original_avatar === item.avatar : reply.name === item.name);
        if (!character) return;
        const job = statesFor(ctx).get(summarySourceKey(character));
        if (!job || !['waiting', 'comparing'].includes(job.stage)) return;
        if (job.afterTask) return job.afterTask;
        if (ctx.chat.length <= job.messageIndex) return;
        job.detachSignal?.();
        job.replyIndex = ctx.chat.length;
        job.replyText = String(reply.mes);
        job.afterTask = finish(job, reply);
        return job.afterTask;
    }

    function stop(character) {
        const ctx = getContext();
        const job = statesFor(ctx).get(summarySourceKey(character));
        if (job) { job.controller.abort(); clear(job); }
    }

    return {
        beforeCharacter, afterCharacter, stop,
        ignoreMessage(message) {
            if (message && typeof message === 'object') ignored.add(message);
            for (const character of getCharacters()) stop(character);
        },
        getStatus(character) {
            const job = statesFor(getContext()).get(summarySourceKey(character));
            return job ? { running: ['preparing', 'comparing'].includes(job.stage),
                pending: ['preparing', 'comparing'].includes(job.stage) ? 1 : 0,
                sideCount: job.side.length, stage: job.stage, lastError: job.lastError } : {};
        },
    };
}
