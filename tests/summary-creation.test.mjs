import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryCreation, parseSummaryCreation } from '../memory/summary-creation.js';
import { selectRpMessages } from '../agents/rp-context.js';

test('hidden RP inclusion is opt-in and never admits notices, tools or OOC', () => {
    const messages = [
        { name: 'Mirella', mes: 'Visible.' },
        { name: 'Mirella', is_system: true, mes: 'Hidden character.' },
        { name: 'Juliano', is_user: true, is_system: true, mes: 'Hidden user.' },
        { name: 'System', is_system: true, mes: 'A host notice.' },
        { name: 'Mirella', is_system: true, mes: 'Tool.', extra: { type: 'tool_response' } },
        { name: 'Mirella', is_system: true, mes: 'Generated notice.', extra: { type: 'generic' } },
        { name: 'Mirella', mes: 'OOC debug' },
    ];
    const options = { characterNames: ['Mirella'], isOoc: text => text.startsWith('OOC') };
    assert.deepEqual(selectRpMessages(messages, options).map(message => message.mes), ['Visible.']);
    assert.deepEqual(selectRpMessages(messages, { ...options, includeHidden: true }).map(message => message.mes),
        ['Visible.', 'Hidden character.', 'Hidden user.']);
});

const entry = index => ({ title: 'Escape', bullet: 'I escaped.', descriptive: 'I escaped with Juliano.',
    importance: 3, last_relevant_message_index: index });

test('structured output rejects malformed JSON, scope injection and invalid importance', () => {
    assert.deepEqual(parseSummaryCreation(JSON.stringify({ memories: [entry(2)] }), [1, 2]), [entry(2)]);
    assert.deepEqual(parseSummaryCreation('{"memories":[]}', [1]), []);
    for (const output of ['not JSON', 'null', '[]', '{"events":[]}',
        JSON.stringify({ memories: [{ ...entry(2), namespace: 'malicious' }] }),
        JSON.stringify({ memories: [{ ...entry(2), importance: 0 }] }),
        JSON.stringify({ memories: [{ ...entry(2), importance: 5.5 }] })]) {
        assert.throws(() => parseSummaryCreation(output, [1, 2]));
    }
});

test('code distributes chronological memories over actual source indices and ignores legacy model indices', () => {
    const { last_relevant_message_index, ...withoutIndex } = entry(999);
    const output = JSON.stringify({ memories: [withoutIndex, entry(999), withoutIndex] });
    assert.deepEqual(parseSummaryCreation(output, [101, 105, 109, 113, 120])
        .map(memory => memory.last_relevant_message_index), [105, 113, 120]);
    assert.deepEqual(parseSummaryCreation(JSON.stringify({ memories: [withoutIndex] }), [101, 120]), [entry(120)]);
    assert.deepEqual(parseSummaryCreation(output, [120]).map(memory => memory.last_relevant_message_index), [120, 120, 120]);
    assert.throws(() => parseSummaryCreation(output, []), /source messages/);
});

function fixture(fetchImpl) {
    const character = { name: 'Mirella', avatar: 'm.png', summary: { namespace: 'rp', groupId: 'mirella' } };
    const agent = { id: 'creation:mirella', ownerCharacterAvatar: 'm.png', contextMessages: 2 };
    const ctx = { chatMetadata: {}, chatId: 'chat', groupId: 'group', chat: [
        { name: 'Juliano', is_user: true, mes: 'I open the door.' },
        { name: 'Mirella', mes: 'I follow him.' },
    ] };
    let saves = 0;
    ctx.saveMetadata = async () => { saves++; };
    let current = ctx;
    const bodies = [];
    const response = body => ({ ok: true, json: async () => ({ meta: {}, results: [{
        kind: 'memory', id: body.registration_key, importance: body.importance,
        last_relevant_message_index: body.last_relevant_message_index,
        references: { n2: [{ text: body.descriptive }] },
    }] }) });
    const engine = createSummaryCreation({
        getContext: () => current, getCharacter: () => character,
        selectMessages: (_agent, context) => selectRpMessages(context.chat),
        fetchImpl: async (_url, options) => {
            assert(saves > 0, 'Persist the exact envelope before posting');
            const body = JSON.parse(options.body);
            bodies.push(body);
            return fetchImpl ? fetchImpl(body, bodies.length, response) : response(body);
        },
    });
    return { engine, character, agent, ctx, bodies, changeChat: next => { current = next; } };
}

test('creation persists scoped envelopes, updates the cursor only after confirmation and excludes old input', async () => {
    const f = fixture();
    const input = f.engine.prepare(f.agent);
    const result = await f.engine.save(f.agent, JSON.stringify({ memories: [entry(2)] }), input);
    assert.equal(result.saved.length, 1);
    const body = f.bodies[0];
    assert.equal(body.namespace, 'rp');
    assert.equal(body.character, 'Mirella');
    assert.equal(body.source_chat_id, 'chat');
    assert(body.registration_key.startsWith('backstage:'));
    assert.equal(typeof body.reference_time, 'string');
    assert.equal(f.engine.getState(f.agent).lastSavedIndex, 2);
    assert.equal(f.engine.getState(f.agent).pending, undefined);
    assert.throws(() => f.engine.prepare(f.agent), /No new RP/);
    f.ctx.chat.push({ name: 'Juliano', is_user: true, mes: 'Continue.' });
    assert.deepEqual(f.engine.prepare(f.agent).entries.map(entry => entry.index), [3]);
});

test('uncertain writes require explicit retry using byte-identical keys, timestamps and content', async () => {
    const f = fixture((body, count, response) => {
        if (count === 1) throw new Error('Lost response after server write');
        return response(body);
    });
    const output = JSON.stringify({ memories: [entry(2)] });
    await assert.rejects(f.engine.save(f.agent, output, f.engine.prepare(f.agent)), /Lost response/);
    assert.equal(f.bodies.length, 1, 'There is no automatic retry');
    assert.equal(f.engine.getState(f.agent).lastSavedIndex, undefined);
    assert.throws(() => f.engine.prepare(f.agent), /Retry Save/);
    await f.engine.retry(f.agent);
    assert.deepEqual(f.bodies[1], f.bodies[0]);
    assert.equal(f.engine.getState(f.agent).lastSavedIndex, 2);
});

test('partial batches retry only unconfirmed entries, never regenerate earlier memories', async () => {
    const f = fixture((body, count, response) => count === 2
        ? { ok: false, status: 502, text: async () => 'Failed' } : response(body));
    const output = JSON.stringify({ memories: [entry(1), entry(2)] });
    await assert.rejects(f.engine.save(f.agent, output, f.engine.prepare(f.agent)), /502/);
    assert.equal(f.engine.getState(f.agent).pending.saved.length, 1);
    await f.engine.retry(f.agent);
    assert.equal(f.bodies.length, 3);
    assert.deepEqual(f.bodies[2], f.bodies[1]);
    assert.notEqual(f.bodies[0].registration_key, f.bodies[1].registration_key);
});

test('edited source, changed scopes, cancelled operations and unsaved journals prevent new writes', async () => {
    for (const kind of ['edit', 'scope', 'cancel', 'journal']) {
        const f = fixture();
        const input = f.engine.prepare(f.agent);
        const controller = new AbortController();
        if (kind === 'edit') f.ctx.chat[0].mes = 'Changed.';
        if (kind === 'scope') f.character.summary.namespace = 'other';
        if (kind === 'cancel') controller.abort();
        if (kind === 'journal') f.ctx.saveMetadata = async () => { throw new Error('Disk unavailable'); };
        await assert.rejects(f.engine.save(f.agent, JSON.stringify({ memories: [entry(2)] }), input, f.ctx, controller.signal));
        assert.equal(f.bodies.length, 0, kind);
    }
});

test('empty memories advance the source cursor without writes; oversized backlogs are never skipped', async () => {
    const f = fixture();
    await f.engine.save(f.agent, '{"memories":[]}', f.engine.prepare(f.agent));
    assert.equal(f.bodies.length, 0);
    f.ctx.chat.push(...['One', 'Two', 'Three'].map(mes => ({ name: 'Juliano', is_user: true, mes })));
    assert.throws(() => f.engine.prepare(f.agent), /unsummarized messages/);
});

test('creation delays the final chat positions and only advances its cursor to included messages', async () => {
    const f = fixture();
    f.ctx.chat = Array.from({ length: 140 }, (_, index) => ({ name: 'Mirella', mes: `Message ${index + 1}` }));
    f.agent.contextMessages = 30;
    f.agent.contextMessageOffset = 10;
    const input = f.engine.prepare(f.agent);
    assert.equal(input.entries[0].index, 101);
    assert.equal(input.throughIndex, 130);
    assert.equal(input.entries.length, 30);
    await f.engine.save(f.agent, JSON.stringify({ memories: [entry(999)] }), input);
    assert.equal(f.bodies[0].last_relevant_message_index, 130);
    assert.equal(f.engine.getState(f.agent).lastSavedIndex, 130);
    assert.throws(() => f.engine.prepare(f.agent), /No new RP/);
    f.ctx.chat.push(...Array.from({ length: 10 }, (_, index) => ({ name: 'Mirella', mes: `New ${index}` })));
    const next = f.engine.prepare(f.agent);
    assert.equal(next.entries[0].index, 131);
    assert.equal(next.throughIndex, 140);
});

test('offset at or beyond chat length leaves the creation cursor untouched and performs no writes', () => {
    for (const offset of [2, 20]) {
        const f = fixture();
        f.agent.contextMessageOffset = offset;
        assert.throws(() => f.engine.prepare(f.agent), /No new RP/);
        assert.equal(f.engine.getState(f.agent), null);
        assert.equal(f.bodies.length, 0);
    }
});
