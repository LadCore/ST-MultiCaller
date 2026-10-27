import { getSummaryScope, normalizeSummaryConfig, summarySourceKey } from './character-summary.js';
import { decideMemoryUsage, planMemoryBoost } from './reinforcement-policy.js';
import { checkSummaryMemoryUsage } from './summary-usage.js';
import { findReinforcementCandidates, patchMemoryBoost, readScopedMemory } from './memorybox-client.js';

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
        if (ownReply) {
            previousIndex = index + 1;
            break;
        }
        entries.push({ index: index + 1, role: message.is_user ? 'user' : 'assistant',
            name: String(message.name ?? ''), content: String(message.mes) });
    }
    entries.reverse();
    return { previousIndex, messageIndex: chat.length, entries,
        messages: entries.map(({ role, name, content }) => ({ role, name, content })) };
}

/** Pre-turn per-character queues; candidate checks run concurrently without changing host profiles. */
export function createMemoryReinforcement({
    getContext, getCharacters, onEvent = () => {}, isOocMessage = () => false,
    findCandidates = findReinforcementCandidates, checkUsage = checkSummaryMemoryUsage,
    readMemory = readScopedMemory, patchBoost = patchMemoryBoost,
}) {
    const chats = new WeakMap();
    const ignored = new WeakSet();
    const collect = (ctx, character) => collectCharacterInterval(ctx.chat ?? [], character,
        message => ignored.has(message) || isOocMessage(message.mes));
    const statesFor = metadata => {
        if (!chats.has(metadata)) chats.set(metadata, new Map());
        return chats.get(metadata);
    };
    const lookup = character => getCharacters().find(item => character.avatar
        ? item.avatar === character.avatar : item.name === character.name);
    const persist = async ctx => {
        if (getContext().chatMetadata !== ctx.chatMetadata) throw new DOMException('Chat changed before saving the reinforcement receipt.', 'AbortError');
        await ctx.saveMetadata?.();
    };

    function emit(job, stage, data = {}, level = 'info') {
        onEvent({ runId: job.runId, character: job.character.name, scope: job.scope,
            message_index: job.messageIndex, at: new Date().toISOString(), stage, level, ...data });
    }

    function assertCurrent(job) {
        const current = getContext();
        const character = lookup(job.character);
        if (job.signal.aborted || job.state.epoch !== job.epoch
            || current.chatMetadata !== job.ctx.chatMetadata || current.chatId !== job.ctx.chatId
            || current.groupId !== job.ctx.groupId || !character
            || JSON.stringify(collect(current, character)) !== job.intervalSnapshot
            || summarySourceKey(character) !== job.sourceKey
            || !normalizeSummaryConfig(character.summary).reinforcement.enabled
            || JSON.stringify(normalizeSummaryConfig(character.summary)) !== JSON.stringify(job.settings)) {
            throw new DOMException('Memory reinforcement stopped: conversation interval, source or configuration changed.', 'AbortError');
        }
    }

    function updateCache(job, memory) {
        assertCurrent(job);
        const cache = job.ctx.chatMetadata.sceneDirector?.characterSummaries?.[job.character.avatar || job.character.name];
        if (cache?.sourceKey !== job.sourceKey || !Array.isArray(cache.allMemories)) return;
        const existing = cache.allMemories.find(item => item.id === memory.id);
        if (existing) Object.assign(existing, memory);
        else cache.allMemories.push(memory);
        // Native saveMetadata saves the whole chat; persist the cache once at the end of this job.
    }

    async function reinforceCandidate(job, candidate) {
        assertCurrent(job);
        const verifiedText = candidate.text;
        const options = { signal: job.signal };
        const messages = job.messages;
        const startedAt = performance.now();
        emit(job, 'usage-request', { memoryId: candidate.id, request: { reference: candidate.text, messages } });
        const usage = await checkUsage(candidate.text, messages, options);
        assertCurrent(job);
        const decision = decideMemoryUsage(usage, job.settings.reinforcement);
        emit(job, 'usage-result', { memoryId: candidate.id, result: usage, decision,
            durationMs: Math.round(performance.now() - startedAt) });
        if (!decision.accepted) return { memoryId: candidate.id, action: 'rejected', ...decision };
        emit(job, 'read-request', { memoryId: candidate.id, request: { operation: 'GET', scope: job.scope, id: candidate.id } });
        const fresh = await readMemory(job.scope, candidate.id, options);
        assertCurrent(job);
        emit(job, 'read-result', { memoryId: candidate.id, memory: fresh });
        updateCache(job, fresh);
        if (fresh.text !== verifiedText) return { memoryId: candidate.id, action: 'skipped', reason: 'N2 changed since verification.' };
        const plan = planMemoryBoost(fresh, job.messageIndex, job.settings);
        emit(job, 'boost-calculation', { memoryId: candidate.id, importance: fresh.importance,
            originIndex: fresh.last_relevant_message_index, previousBoost: fresh.boost, cutoff: job.settings.minRating, plan });
        if (Number.isFinite(plan.calculated?.rating) && plan.calculated.rating < job.settings.minRating) {
            emit(job, 'outside-memory-used', { memoryId: candidate.id, text: fresh.text, result: usage,
                rating: plan.calculated.rating, cutoff: job.settings.minRating });
        }
        if (!plan.apply) return { memoryId: candidate.id, action: 'skipped', ...plan };
        assertCurrent(job);
        emit(job, 'patch-request', { memoryId: candidate.id, request: { operation: 'PATCH', id: candidate.id,
            ...job.scope, boost: plan.boost } });
        let confirmed;
        try {
            confirmed = await patchBoost(job.scope, candidate.id, plan.boost, options);
        } catch (error) {
            emit(job, 'patch-unconfirmed', { memoryId: candidate.id, error: error.message, retry: false }, 'error');
            assertCurrent(job);
            // A failed HTTP response may hide a successful write. Reconcile with GET, never another PATCH.
            emit(job, 'reconciliation-request', { memoryId: candidate.id, request: { operation: 'GET', scope: job.scope, id: candidate.id } });
            confirmed = await readMemory(job.scope, candidate.id, options);
            emit(job, 'reconciliation-result', { memoryId: candidate.id, memory: confirmed });
            if (confirmed.boost?.message_index !== plan.boost.message_index || !Number.isFinite(confirmed.boost.value)
                || Math.abs(confirmed.boost.value - plan.boost.value) > 1e-12) {
                throw new Error(`Unconfirmed boost for ${candidate.id}. No retry performed. ${error.message}`);
            }
        }
        assertCurrent(job);
        if (confirmed.importance !== fresh.importance
            || confirmed.last_relevant_message_index !== fresh.last_relevant_message_index) {
            throw new Error(`Memory source changed while boosting ${candidate.id}; refresh required.`);
        }
        updateCache(job, confirmed);
        emit(job, 'patch-confirmed', { memoryId: candidate.id, memory: confirmed, target: plan.target });
        return { memoryId: candidate.id, action: 'boosted', boost: confirmed.boost, target: plan.target };
    }

    async function run(job) {
        job.state.running = true;
        job.state.controller = job.controller;
        job.state.lastError = '';
        job.receipt.phase = 'running';
        const outcomes = [];
        const startedAt = performance.now();
        try {
            assertCurrent(job);
            await persist(job.ctx);
            assertCurrent(job);
            emit(job, 'start', { context: { scope: job.scope, query: job.text, messages: job.messages,
                previousCharacterMessageIndex: job.previousIndex, throughMessageIndex: job.messageIndex,
                messageCount: job.messages.length, parallel: true,
                limit: job.settings.reinforcement.candidateLimit }, settings: job.settings });
            emit(job, 'search-request', { request: { ...job.scope, query: job.text, limit: job.settings.reinforcement.candidateLimit } });
            const found = await findCandidates(job.scope, job.text, job.settings.reinforcement.candidateLimit,
                { signal: job.signal });
            assertCurrent(job);
            emit(job, 'search-result', found);
            // Settle every worker before completing the job, including cancellation and partial failures.
            const results = await Promise.allSettled(found.candidates.map(async candidate => {
                try {
                    const outcome = await reinforceCandidate(job, candidate);
                    emit(job, 'candidate-complete', outcome);
                    return outcome;
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    const outcome = { memoryId: candidate.id, action: 'error', error: error.message };
                    emit(job, 'candidate-error', outcome, 'error');
                    return outcome;
                }
            }));
            outcomes.push(...results.filter(result => result.status === 'fulfilled').map(result => result.value));
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected) throw rejected.reason;
            assertCurrent(job);
            const errors = outcomes.filter(outcome => outcome.action === 'error');
            job.receipt.phase = errors.length ? 'error' : 'success';
            job.state.lastError = errors.map(outcome => outcome.error).join(' | ');
        } catch (error) {
            job.receipt.phase = error.name === 'AbortError' ? 'stopped' : 'error';
            job.state.lastError = error.message;
            emit(job, 'run-error', { error: error.message }, error.name === 'AbortError' ? 'warn' : 'error');
        } finally {
            job.state.running = false;
            job.state.pending--;
            job.receipt.completedAt = new Date().toISOString();
            try { await persist(job.ctx); }
            catch (error) {
                job.receipt.phase = error.name === 'AbortError' ? 'stopped' : 'error';
                job.state.lastError = error.message;
                emit(job, 'receipt-save-error', { error: error.message }, 'error');
            }
            emit(job, 'finish', { status: job.receipt.phase, outcomes, error: job.state.lastError,
                durationMs: Math.round(performance.now() - startedAt), messageCount: job.messages.length });
        }
        return { status: job.receipt.phase, error: job.state.lastError };
    }

    async function beforeCharacter(character, { signal } = {}) {
        const ctx = getContext();
        character = lookup(character);
        if (!character) return;
        const settings = normalizeSummaryConfig(character.summary);
        if (!settings.reinforcement.enabled || !settings.namespace || !settings.groupId) return;
        const interval = collect(ctx, character);
        if (!interval.messages.length) return;
        const { messageIndex, previousIndex, messages } = interval;
        const intervalSnapshot = JSON.stringify(interval);
        const text = messages.map(message => `${message.name}: ${message.content}`).join('\n\n');
        const sourceKey = summarySourceKey(character);
        const bytes = new TextEncoder().encode(JSON.stringify(['pre-turn-v1', sourceKey, intervalSnapshot, settings]));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        if (getContext().chatMetadata !== ctx.chatMetadata || signal?.aborted) {
            throw new DOMException('Memory reinforcement cancelled before scheduling.', 'AbortError');
        }
        ctx.chatMetadata.sceneDirector ??= {};
        const ledger = ctx.chatMetadata.sceneDirector.memoryReinforcement ??= {};
        const map = statesFor(ctx.chatMetadata);
        if (!map.has(sourceKey)) map.set(sourceKey, { running: false, pending: 0, epoch: 0,
            tail: Promise.resolve(), jobs: new Map(), lastError: '' });
        const state = map.get(sourceKey);
        if (state.jobs.has(key)) return state.jobs.get(key);
        if (ledger[key]?.phase === 'success') {
            onEvent({ runId: `duplicate-${key}`, character: character.name, stage: 'duplicate-skipped',
                message_index: messageIndex, level: 'info', receipt: ledger[key] });
            return;
        }
        state.pending++;
        const receipt = ledger[key] = { phase: 'queued', messageIndex, previousIndex, createdAt: new Date().toISOString() };
        const controller = new AbortController();
        const job = { ctx, character: structuredClone(character), scope: getSummaryScope(character), sourceKey,
            settings, messages, previousIndex, intervalSnapshot, messageIndex, text,
            runId: `memory-boost-${key}`, state, receipt, controller,
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, epoch: state.epoch };
        const task = state.tail.catch(() => {}).then(() => run(job)).finally(() => state.jobs.delete(key));
        state.jobs.set(key, task);
        state.tail = task;
        return task;
    }

    function stop(character) {
        const state = statesFor(getContext().chatMetadata).get(summarySourceKey(character));
        if (!state) return;
        state.epoch++;
        state.controller?.abort();
    }

    return {
        beforeCharacter, stop,
        ignoreMessage(message) { if (message && typeof message === 'object') ignored.add(message); },
        getStatus(character) {
            const state = statesFor(getContext().chatMetadata).get(summarySourceKey(character));
            return state ? { running: state.running, pending: state.pending, lastError: state.lastError } : {};
        },
    };
}
