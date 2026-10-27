import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReinforcementConfig, decideMemoryUsage, planMemoryBoost } from '../memory/reinforcement-policy.js';
import { calculateSummaryRating, normalizeSummaryHalfLives } from '../memory/summary-rating.js';
import { collectCharacterInterval, createMemoryReinforcement } from '../memory/reinforcement-runner.js';
import { getCharacterSummary, saveCharacterSummary } from '../memory/character-summary.js';

const settings = { namespace: 'rp', groupId: 'mirella', minRating: 0.5,
    reinforcement: { enabled: true, minUsageProbability: 0.8, minConfidence: 0.8, candidateLimit: 25 } };
const memory = (importance = 1) => ({ id: 'memory-one', text: 'The memory in her own words.',
    importance, last_relevant_message_index: 1, boost: null });
const positive = { verdict: 'used', usage_probability: 0.9, confidence: 0.85, model: 'Kev', evaluated_messages: 1 };

test('used and both independent thresholds must pass, including boundary values', () => {
    const thresholds = normalizeReinforcementConfig(settings.reinforcement);
    assert.equal(decideMemoryUsage(positive, thresholds).accepted, true);
    for (const changes of [{ verdict: 'same_topic' }, { usage_probability: 0.79 }, { confidence: 0.79 }]) {
        assert.equal(decideMemoryUsage({ ...positive, ...changes }, thresholds).accepted, false);
    }
    assert.equal(decideMemoryUsage({ ...positive, confidence: 0.8, usage_probability: 0.8 }, thresholds).accepted, true);
    assert.equal(normalizeReinforcementConfig().enabled, false);
});

test('importance sets the target while source and boost decay on their own reference indices', () => {
    for (let importance = 1; importance <= 5; importance++) {
        const candidate = memory(importance);
        const plan = planMemoryBoost(candidate, 10001, settings);
        assert.equal(plan.apply, true);
        const result = calculateSummaryRating({ ...candidate, boost: plan.boost }, 10001, normalizeSummaryHalfLives());
        assert(Math.abs(result.rating - (0.5 + 0.5 * importance / 5)) < 1e-12);
        const later = calculateSummaryRating({ ...candidate, boost: plan.boost },
            10001 + normalizeSummaryHalfLives()[importance], normalizeSummaryHalfLives());
        assert(Math.abs(later.rating - result.rating / 2) < 1e-12);
        assert.equal(candidate.last_relevant_message_index, 1);
    }
    assert.equal(planMemoryBoost({ ...memory(), boost: { value: 0.9, message_index: 10001 } }, 10001, settings).apply, false);
    assert.equal(planMemoryBoost({ ...memory(), boost: { value: 0.9, message_index: 10000 } }, 10001, settings).apply, false);
});

function fixture(overrides = {}) {
    const character = { name: 'Mirella Veyr', avatar: 'mirella.png', summary: structuredClone(settings) };
    const message = { name: 'Juliano', is_user: true, mes: 'I remember what happened.' };
    const previous = { name: character.name, original_avatar: character.avatar, mes: 'Her previous reply.' };
    const ctx = { chatMetadata: {}, chat: [...Array(999), previous, message],
        chatId: 'chat', groupId: 'group', saveMetadata() {} };
    const events = [];
    const patches = [];
    let current = ctx;
    const candidate = memory();
    saveCharacterSummary(ctx, character, { allMemories: [candidate] });
    const engine = createMemoryReinforcement({
        getContext: () => current, getCharacters: () => [character], onEvent: event => events.push(event),
        findCandidates: async () => ({ candidates: [candidate], found: 1, meta: {} }),
        checkUsage: async () => positive,
        readMemory: async () => candidate,
        patchBoost: async (_scope, _id, boost) => { patches.push(boost); return { ...candidate, boost }; },
        ...overrides,
    });
    return { engine, character, message, ctx, events, patches, candidate, changeChat: next => { current = next; } };
}

test('interval includes every participant after the last own reply, not the previous reply itself', () => {
    const character = { name: 'Mirella Veyr', avatar: 'mirella.png' };
    const previous = { name: character.name, original_avatar: character.avatar, mes: 'Old response' };
    const chat = [previous,
        { name: 'Juliano', is_user: true, mes: 'Do you remember Aiko?' },
        { name: 'Tio Klarus', mes: 'I remember the escape.' },
        { name: 'GM', is_system: true, mes: 'System note' },
        { name: 'GM', extra: { type: 'tool_response' }, mes: 'Dice result' },
        { name: 'Juliano', is_user: true, mes: 'We should talk about her.' },
        { name: 'Mirella Veyr', mes: 'OOC private test' }];
    const interval = collectCharacterInterval(chat, character, message => message.mes.startsWith('OOC'));
    assert.equal(interval.previousIndex, 1);
    assert.equal(interval.messageIndex, 7);
    assert.deepEqual(interval.entries.map(entry => entry.index), [2, 3, 6]);
    assert.deepEqual(interval.messages.map(message => message.name), ['Juliano', 'Tio Klarus', 'Juliano']);
    assert.deepEqual(interval.messages.map(message => message.role), ['user', 'assistant', 'user']);
    assert.equal(collectCharacterInterval([previous], character).messages.length, 0);
    assert.equal(collectCharacterInterval(chat.slice(1, 3), character).messages.length, 2,
        'A first turn without an earlier reply uses all available RP messages');
    const wrongAvatar = { ...previous, original_avatar: 'someone-else.png' };
    assert.equal(collectCharacterInterval([wrongAvatar], character).messages.length, 1);
});

test('every candidate receives the same full interval concurrently; one failure does not discard other boosts', async () => {
    let release;
    let allStarted;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { allStarted = resolve; });
    const received = [];
    const candidates = [1, 2, 3].map(index => ({ ...memory(), id: `memory-${index}`, text: `Memory ${index}` }));
    const patches = [];
    let queried;
    const f = fixture({
        findCandidates: async (_scope, query) => { queried = query; return { candidates }; },
        checkUsage: async (reference, messages) => {
            received.push({ reference, messages });
            if (received.length === 3) allStarted();
            await gate;
            if (reference === 'Memory 2') throw new Error('Verifier unavailable');
            return { ...positive, evaluated_messages: messages.length };
        },
        readMemory: async (_scope, id) => structuredClone(candidates.find(memory => memory.id === id)),
        patchBoost: async (_scope, id, boost) => {
            patches.push(id);
            return { ...candidates.find(memory => memory.id === id), boost };
        },
    });
    f.ctx.chat.push({ name: 'Tio Klarus', mes: 'Aiko was with us.' },
        { name: 'Juliano', is_user: true, mes: 'I will not forget her.' });
    const pending = f.engine.beforeCharacter(f.character);
    await started;
    assert.equal(received.length, 3, 'All checks must start before any one is allowed to finish');
    for (const { messages } of received) {
        assert.deepEqual(messages.map(message => message.name), ['Juliano', 'Tio Klarus', 'Juliano']);
        assert.equal(messages[0].content, f.message.mes);
    }
    assert.match(queried, /Tio Klarus: Aiko was with us/);
    assert.match(queried, /Juliano: I will not forget her/);
    release();
    const result = await pending;
    assert.equal(result.status, 'error');
    assert.deepEqual(patches.sort(), ['memory-1', 'memory-3']);
    assert.equal(f.events.at(-1).messageCount, 3);
    assert.equal(typeof f.events.at(-1).durationMs, 'number');
});

test('caller cancellation and newly appended chat messages prevent writes from a stale interval', async () => {
    for (const action of ['abort', 'append']) {
        let release;
        let started;
        const entered = new Promise(resolve => { started = resolve; });
        const f = fixture({ checkUsage: async () => {
            started();
            return new Promise(resolve => { release = resolve; });
        } });
        const controller = new AbortController();
        const pending = f.engine.beforeCharacter(f.character, { signal: controller.signal });
        await entered;
        if (action === 'abort') controller.abort();
        else f.ctx.chat.push({ name: 'Tio Klarus', mes: 'A new message.' });
        release(positive);
        const result = await pending;
        assert.equal(result.status, 'stopped', action);
        assert.equal(f.patches.length, 0, action);
    }
});

test('a pre-turn interval reinforces a memory outside the box before injection and logs the full trace', async () => {
    const f = fixture();
    let saves = 0;
    f.ctx.saveMetadata = async () => { saves++; };
    assert.equal(getCharacterSummary(f.ctx, f.character).memories.length, 0);
    await f.engine.beforeCharacter(f.character);
    assert.equal(f.patches.length, 1);
    assert.equal(f.patches[0].message_index, 1001);
    assert.equal(f.candidate.importance, 1);
    assert.equal(f.candidate.last_relevant_message_index, 1);
    assert.equal(getCharacterSummary(f.ctx, f.character).memories.length, 1);
    assert.equal(getCharacterSummary(f.ctx, f.character).text, f.candidate.text);
    assert.equal(f.events.at(-1).status, 'success');
    assert.equal(saves, 2, 'Metadata must not save the entire chat for every candidate');
    for (const stage of ['search-request', 'usage-result', 'boost-calculation', 'patch-request', 'patch-confirmed']) {
        assert(f.events.some(event => event.stage === stage), stage);
    }
    const recall = f.events.find(event => event.stage === 'outside-memory-used');
    assert(recall);
    assert.equal(recall.text, f.candidate.text);
    assert.equal(recall.result.verdict, 'used');
    assert(recall.rating < recall.cutoff);
    await f.engine.beforeCharacter(f.character);
    assert.equal(f.patches.length, 1);
    assert.equal(f.events.at(-1).stage, 'duplicate-skipped');
    assert.equal(f.events.filter(event => event.stage === 'outside-memory-used').length, 1);
});

test('low confidence or disabled automation never patches', async () => {
    const low = fixture({ checkUsage: async () => ({ ...positive, confidence: 0.7 }) });
    await low.engine.beforeCharacter(low.character);
    assert.equal(low.patches.length, 0);
    assert.equal(low.events.some(event => event.stage === 'outside-memory-used'), false);
    assert.equal(low.events.find(event => event.stage === 'usage-result').decision.accepted, false);
    const off = fixture();
    off.character.summary.reinforcement.enabled = false;
    await off.engine.beforeCharacter(off.character);
    assert.equal(off.events.length, 0);
});

test('confirmed use inside the box does not emit an outside-memory notification', async () => {
    const f = fixture();
    f.character.summary.minRating = 0;
    await f.engine.beforeCharacter(f.character);
    assert.equal(f.events.some(event => event.stage === 'outside-memory-used'), false);
});

test('a newer remote boost, an edited N2 or a stopped message cannot be overwritten', async () => {
    const newer = fixture({ readMemory: async () => ({ ...memory(), boost: { value: 0.9, message_index: 1002 } }) });
    await newer.engine.beforeCharacter(newer.character);
    assert.equal(newer.patches.length, 0);
    const edited = fixture({ readMemory: async () => ({ ...memory(), text: 'A revised N2.' }) });
    await edited.engine.beforeCharacter(edited.character);
    assert.equal(edited.patches.length, 0);
    const stopped = fixture();
    stopped.engine.ignoreMessage(stopped.message);
    await stopped.engine.beforeCharacter(stopped.character);
    assert.equal(stopped.events.length, 0);
});

test('uncertain PATCH is reconciled by reading, never retried', async () => {
    let written;
    let reads = 0;
    let writes = 0;
    const f = fixture({
        readMemory: async () => { reads++; return { ...memory(), boost: written ?? null }; },
        patchBoost: async (_scope, _id, boost) => { writes++; written = boost; throw new Error('Lost response'); },
    });
    await f.engine.beforeCharacter(f.character);
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    assert.equal(f.events.at(-1).status, 'success');
    assert(f.events.some(event => event.stage === 'patch-unconfirmed'));
    assert(f.events.some(event => event.stage === 'reconciliation-result'));
});

test('changing chats or stopping while verification runs prevents subsequent writes', async () => {
    for (const action of ['chat', 'stop', 'edit']) {
        let release;
        let started;
        const entered = new Promise(resolve => { started = resolve; });
        const f = fixture({ checkUsage: async () => {
            started();
            return new Promise(resolve => { release = resolve; });
        } });
        const pending = f.engine.beforeCharacter(f.character);
        await entered;
        if (action === 'chat') f.changeChat({ chatMetadata: {}, chat: [], chatId: 'other' });
        if (action === 'stop') f.engine.stop(f.character);
        if (action === 'edit') f.message.mes = 'Edited reply';
        release(positive);
        await pending;
        assert.equal(f.patches.length, 0, action);
        assert.equal(f.events.at(-1).status, 'stopped', action);
    }
});

test('duplicate in-flight calls await the same job and an unconfirmed write is never retried', async () => {
    let active = 0;
    let maxActive = 0;
    let writes = 0;
    const f = fixture({
        checkUsage: async () => {
            active++; maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--; return positive;
        },
        patchBoost: async () => { writes++; throw new Error('Backend offline'); },
    });
    await Promise.all([f.engine.beforeCharacter(f.character), f.engine.beforeCharacter(f.character)]);
    assert.equal(maxActive, 1);
    assert.equal(writes, 1);
    assert(f.events.filter(event => event.stage === 'finish').every(event => event.status === 'error'));
    assert.match(f.engine.getStatus(f.character).lastError, /Unconfirmed boost/);
});

test('a persisted receipt prevents reprocessing after recreating the runner', async () => {
    const f = fixture();
    await f.engine.beforeCharacter(f.character);
    const events = [];
    const restored = createMemoryReinforcement({ getContext: () => f.ctx,
        getCharacters: () => [f.character], onEvent: event => events.push(event),
        findCandidates: async () => { throw new Error('Must not query on replay'); } });
    await restored.beforeCharacter(f.character);
    assert.equal(events[0].stage, 'duplicate-skipped');
});

test('stop cancels work, and a metadata failure does not leave the queue running', async () => {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = fixture({ checkUsage: async () => {
        entered(); return new Promise(resolve => { release = resolve; });
    } });
    const first = f.engine.beforeCharacter(f.character);
    await started;
    const queued = f.engine.beforeCharacter(f.character);
    await new Promise(resolve => setTimeout(resolve, 5));
    f.engine.stop(f.character);
    release(positive);
    await Promise.all([first, queued]);
    assert.equal(f.patches.length, 0);
    assert.equal(f.engine.getStatus(f.character).pending, 0);
    const failed = fixture();
    failed.ctx.saveMetadata = async () => { throw new Error('Cannot save chat'); };
    await failed.engine.beforeCharacter(failed.character);
    assert.equal(failed.patches.length, 0);
    assert.equal(failed.engine.getStatus(failed.character).running, false);
    assert.equal(failed.events.at(-1).status, 'error');
});
