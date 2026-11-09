import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReinforcementConfig, planMemoryBoost } from '../memory/reinforcement-policy.js';
import { calculateSummaryRating, normalizeSummaryHalfLives } from '../memory/summary-rating.js';
import { collectCharacterInterval, createMemoryReinforcement } from '../memory/reinforcement-runner.js';
import { buildSummaryInjection, getCharacterSummary, saveCharacterSummary } from '../memory/character-summary.js';

const memory = (id = 'memory-one', importance = 1) => ({ id, text: `Memory ${id}`, importance,
    last_relevant_message_index: 1, boost: null });
const semantic = id => ({ id, n1: `Bullet ${id}`, matches: [{ fact_id: `fact-${id}`, similarity: 0.9 }] });

/** Exercise both phases with exact source records, controlled semantic results and an in-memory remote store. */
function fixture(overrides = {}) {
    const character = { name: 'Mirella Veyr', avatar: 'm.png', summary: { enabled: true,
        namespace: 'rp', groupId: 'mirella', minRating: 0.5, reinforcement: { enabled: true, minSimilarity: 0.6 } } };
    const ctx = { chatMetadata: {}, chatId: 'chat', groupId: 'group', saveMetadata: async () => {},
        chat: [...Array(999), { name: character.name, original_avatar: character.avatar, mes: 'Previous reply' },
            { name: 'Juliano', is_user: true, mes: 'Remember Aiko?' }] };
    const remote = new Map(['one', 'two', 'inside'].map(id => [id, memory(id, id === 'inside' ? 5 : 1)]));
    remote.get('inside').last_relevant_message_index = 1001;
    saveCharacterSummary(ctx, character, { allMemories: [...remote.values()].map(item => structuredClone(item)) });
    let current = ctx;
    const searches = [], patches = [], events = [];
    const engine = createMemoryReinforcement({ getContext: () => current, getCharacters: () => [character],
        onEvent: event => events.push(event),
        findCandidates: async (scope, query, limit, options) => {
            searches.push({ scope, query, limit, options });
            return { candidates: query.includes('Juliano:') ? [semantic('one'), semantic('two'), semantic('inside')]
                : [semantic('one'), semantic('inside'), semantic('unrelated')] };
        },
        readMemory: async (_scope, id) => structuredClone(remote.get(id)),
        patchBoost: async (_scope, id, boost) => {
            patches.push({ id, boost });
            Object.assign(remote.get(id), { boost });
            return structuredClone(remote.get(id));
        }, ...overrides });
    const reply = (text = 'Aiko mattered to me.') => {
        const message = { name: character.name, original_avatar: character.avatar, mes: text };
        ctx.chat.push(message);
        return message;
    };
    return { character, ctx, engine, remote, searches, patches, events, reply, changeChat: next => { current = next; } };
}

test('similarity cutoff is optional, accepts zero/negative values and survives normalization', () => {
    assert.equal(normalizeReinforcementConfig().minSimilarity, null);
    assert.equal(normalizeReinforcementConfig({ minSimilarity: '' }).minSimilarity, null);
    for (const value of [0, -0.5, 0.7]) assert.equal(normalizeReinforcementConfig({ minSimilarity: String(value) }).minSimilarity, value);
    assert.equal(normalizeReinforcementConfig({ minSimilarity: 2 }).minSimilarity, 1);
    assert.equal(normalizeReinforcementConfig({ minSimilarity: 'invalid' }).minSimilarity, null);
});

test('both automatic phases search speech without editing source messages', async () => {
    const f = fixture();
    f.ctx.chat.at(-1).mes = '*looks away* Remember *sighs* Aiko?';
    const original = f.ctx.chat.at(-1).mes;
    await f.engine.beforeCharacter(f.character);
    assert.equal(f.searches[0].query, 'Juliano: Remember Aiko?');
    assert.equal(f.ctx.chat.at(-1).mes, original);
    const reply = f.reply('*touches collar* Aiko mattered to me.');
    await f.engine.afterCharacter(reply);
    assert.equal(f.searches[1].query, 'Aiko mattered to me.');
    assert.equal(reply.mes, '*touches collar* Aiko mattered to me.');
});

test('action-only messages neither search nor reinforce memories', async () => {
    const f = fixture();
    f.ctx.chat.at(-1).mes = '*looks away*';
    await f.engine.beforeCharacter(f.character);
    assert.equal(f.searches.length, 0);
    f.ctx.chat.at(-1).mes = 'Remember Aiko?';
    await f.engine.beforeCharacter(f.character);
    await f.engine.afterCharacter(f.reply('*stays silent*'));
    assert.equal(f.searches.length, 1);
    assert.equal(f.patches.length, 0);
    assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
});

test('boost target still uses importance and decays without changing the origin', () => {
    for (let importance = 1; importance <= 5; importance++) {
        const candidate = memory('test', importance);
        const settings = { minRating: 0.5 };
        const plan = planMemoryBoost(candidate, 10001, settings);
        assert.equal(plan.apply, true);
        const now = calculateSummaryRating({ ...candidate, boost: plan.boost }, 10001, normalizeSummaryHalfLives());
        const later = calculateSummaryRating({ ...candidate, boost: plan.boost },
            10001 + normalizeSummaryHalfLives()[importance], normalizeSummaryHalfLives());
        assert(Math.abs(now.rating - (0.5 + 0.5 * importance / 5)) < 1e-12);
        assert(Math.abs(later.rating - now.rating / 2) < 1e-12);
        assert.equal(candidate.last_relevant_message_index, 1);
    }
});

test('retrieval interval includes every participant after the last own reply, excluding tools and OOC', () => {
    const character = { name: 'Mirella', avatar: 'm.png' };
    const chat = [{ name: 'Mirella', original_avatar: 'm.png', mes: 'Previous' },
        { name: 'Juliano', is_user: true, mes: 'A question' }, { name: 'Tio', mes: 'An answer' },
        { mes: 'Dice', extra: { type: 'tool_response' } }, { mes: 'Hidden', is_system: true }, { mes: 'OOC' }];
    const result = collectCharacterInterval(chat, character, item => item.mes === 'OOC');
    assert.deepEqual(result.entries.map(item => item.index), [2, 3]);
    assert.equal(result.previousIndex, 1);
});

test('before phase builds In plus Side without writing ratings, injecting duplicate In IDs or persisting Side', async () => {
    const f = fixture();
    const before = structuredClone(f.ctx.chatMetadata);
    assert.equal((await f.engine.beforeCharacter(f.character)).status, 'ready');
    assert.equal(f.patches.length, 0);
    assert.deepEqual(f.ctx.chatMetadata, before);
    const summary = getCharacterSummary(f.ctx, f.character);
    assert.deepEqual(summary.sideMemories.map(item => item.id), ['one', 'two']);
    assert.equal(summary.memories.length, 1);
    const prompt = buildSummaryInjection(f.ctx, f.character).prompt;
    assert.equal((prompt.match(/Memory inside/g) ?? []).length, 1);
    assert.match(prompt, /Memory one/);
    assert.match(prompt, /Memory two/);
    assert.equal(f.searches[0].options.minSimilarity, 0.6);
});

test('after phase boosts only intersecting Side IDs at the reply index and clears the entire Side', async () => {
    const f = fixture();
    await f.engine.beforeCharacter(f.character);
    const message = f.reply();
    assert.equal((await f.engine.afterCharacter(message)).status, 'success');
    assert.deepEqual(f.patches.map(item => item.id), ['one']);
    assert.equal(f.patches[0].boost.message_index, 1002);
    assert.equal(f.searches[1].query, message.mes);
    assert.equal(f.searches[1].options.minSimilarity, 0.6);
    const summary = getCharacterSummary(f.ctx, f.character);
    assert.equal(summary.sideMemories.length, 0);
    assert(summary.memories.some(item => item.id === 'one'));
    assert(!summary.memories.some(item => item.id === 'two'));
    assert.equal(f.events.filter(event => event.stage === 'side-match').length, 1);
    await f.engine.afterCharacter(message);
    assert.equal(f.patches.length, 1);
});

test('no matching IDs discards Side without any boost', async () => {
    let count = 0;
    const f = fixture({ findCandidates: async () => ({ candidates: ++count === 1 ? [semantic('one')] : [] }) });
    await f.engine.beforeCharacter(f.character);
    await f.engine.afterCharacter(f.reply());
    assert.equal(f.patches.length, 0);
    assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
    assert(f.events.some(event => event.stage === 'side-discarded'));
});

test('semantic failure before or after generation never boosts and always clears Side', async () => {
    for (const failAt of [1, 2]) {
        let count = 0;
        const f = fixture({ findCandidates: async () => {
            if (++count === failAt) throw new Error('Semantic backend offline');
            return { candidates: [semantic('one')] };
        } });
        const pre = await f.engine.beforeCharacter(f.character);
        if (failAt === 2) assert.equal((await f.engine.afterCharacter(f.reply())).status, 'error');
        else assert.equal(pre.status, 'error');
        assert.equal(f.patches.length, 0);
        assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
    }
});

test('cancellation and edited source interval cannot inject or reinforce stale memories', async () => {
    for (const action of ['abort', 'append']) {
        let release;
        const f = fixture({ findCandidates: () => new Promise(resolve => { release = resolve; }) });
        const controller = new AbortController();
        const pending = f.engine.beforeCharacter(f.character, { signal: controller.signal });
        if (action === 'abort') controller.abort();
        else f.ctx.chat.push({ name: 'Tio', mes: 'New message' });
        release({ candidates: [semantic('one')] });
        assert.equal((await pending).status, 'stopped');
        assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
        assert.equal(f.patches.length, 0);
    }
});

test('stopped messages and intermediate tool cycles do not run the after phase', async () => {
    const f = fixture();
    await f.engine.beforeCharacter(f.character);
    const tool = f.reply('Dice');
    tool.extra = { type: 'tool_response' };
    await f.engine.afterCharacter(tool);
    assert.equal(f.searches.length, 1);
    assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 2);
    f.engine.ignoreMessage(tool);
    assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
    await f.engine.afterCharacter(tool);
    assert.equal(f.patches.length, 0);
});

test('duplicate concurrent preparation and completion calls share work rather than double boosting', async () => {
    const f = fixture();
    await Promise.all([f.engine.beforeCharacter(f.character), f.engine.beforeCharacter(f.character)]);
    assert.equal(f.searches.length, 1);
    const message = f.reply();
    await Promise.all([f.engine.afterCharacter(message), f.engine.afterCharacter(message)]);
    assert.equal(f.searches.length, 2);
    assert.equal(f.patches.length, 1);
});

test('a failed PATCH is reconciled with GET, never sent twice', async () => {
    let patchCalls = 0;
    const f = fixture({ patchBoost: async (_scope, id, boost) => {
        patchCalls++;
        Object.assign(f.remote.get(id), { boost });
        throw new Error('Lost response');
    } });
    await f.engine.beforeCharacter(f.character);
    assert.equal((await f.engine.afterCharacter(f.reply())).status, 'success');
    assert.equal(patchCalls, 1);
    assert(getCharacterSummary(f.ctx, f.character).memories.some(item => item.id === 'one'));
});

test('configuration changes and changed injected N2 prevent a stale boost', async () => {
    for (const action of ['config', 'text', 'stop']) {
        const f = fixture();
        await f.engine.beforeCharacter(f.character);
        if (action === 'config') f.character.summary.reinforcement.minSimilarity = 0.8;
        if (action === 'text') f.remote.get('one').text = 'Edited in the backend';
        if (action === 'stop') f.engine.stop(f.character);
        await f.engine.afterCharacter(f.reply());
        assert.equal(f.patches.length, 0, action);
        assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
    }
});

test('Side is isolated by chat and character scope and does not survive a new metadata object', async () => {
    const f = fixture();
    await f.engine.beforeCharacter(f.character);
    const cloned = { ...f.ctx, chatMetadata: structuredClone(f.ctx.chatMetadata) };
    assert.equal(getCharacterSummary(cloned, f.character).sideMemories.length, 0);
    const other = { ...f.character, summary: { ...f.character.summary, groupId: 'other' } };
    assert.equal(getCharacterSummary(f.ctx, other).sideMemories.length, 0);
    f.changeChat(cloned);
    const response = { name: f.character.name, mes: 'A response' };
    cloned.chat = [...cloned.chat, response];
    await f.engine.afterCharacter(response);
    assert.equal(f.patches.length, 0);
});

test('one failed source lookup keeps other Side memories available and reports partial retrieval', async () => {
    const f = fixture({ readMemory: async (_scope, id) => {
        if (id === 'two') throw new Error('Memory unavailable');
        return structuredClone(f.remote.get(id));
    } });
    await f.engine.beforeCharacter(f.character);
    assert.deepEqual(getCharacterSummary(f.ctx, f.character).sideMemories.map(item => item.id), ['one']);
    assert.match(f.engine.getStatus(f.character).lastError, /unavailable/);
    assert.equal(f.patches.length, 0);
});

test('stopping or editing the generated response during the second search prevents any PATCH and clears Side', async () => {
    for (const action of ['stop', 'edit', 'chat']) {
        let release;
        let calls = 0;
        const f = fixture({ findCandidates: async () => ++calls === 1
            ? { candidates: [semantic('one')] }
            : new Promise(resolve => { release = resolve; }) });
        await f.engine.beforeCharacter(f.character);
        const message = f.reply();
        const pending = f.engine.afterCharacter(message);
        if (action === 'stop') f.engine.stop(f.character);
        if (action === 'edit') message.mes = 'Edited response';
        if (action === 'chat') f.changeChat({ ...f.ctx, chatMetadata: {} });
        release({ candidates: [semantic('one')] });
        assert.equal((await pending).status, 'stopped');
        assert.equal(f.patches.length, 0);
        assert.equal(getCharacterSummary(f.ctx, f.character).sideMemories.length, 0);
    }
});

test('a newer remote boost is never lowered, and unconfirmed writes are not automatically retried', async () => {
    const newer = fixture();
    await newer.engine.beforeCharacter(newer.character);
    newer.remote.get('one').boost = { value: 0.99, message_index: 1002 };
    await newer.engine.afterCharacter(newer.reply());
    assert.equal(newer.patches.length, 0);
    let calls = 0;
    const failed = fixture({ patchBoost: async () => { calls++; throw new Error('Write unconfirmed'); } });
    await failed.engine.beforeCharacter(failed.character);
    const message = failed.reply();
    assert.equal((await failed.engine.afterCharacter(message)).status, 'error');
    await failed.engine.afterCharacter(message);
    assert.equal(calls, 1);
    assert.equal(getCharacterSummary(failed.ctx, failed.character).sideMemories.length, 0);
});
