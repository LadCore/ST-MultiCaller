import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatAgentMessages, selectRpMessages, normalizeContextMessageOffset, sliceChatBeforeOffset } from '../agents/rp-context.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const extract = name => {
    const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert(body, name);
    return body;
};

test('offset defaults to zero and clamps invalid, negative, fractional and oversized values safely', () => {
    for (const value of [undefined, null, '', 'invalid', NaN, Infinity, -10]) assert.equal(normalizeContextMessageOffset(value), 0);
    assert.equal(normalizeContextMessageOffset('10'), 10);
    assert.equal(normalizeContextMessageOffset(10.9), 10);
    const chat = [{ mes: 'One' }, { mes: 'Two' }];
    assert.deepEqual(sliceChatBeforeOffset(chat), chat);
    assert.equal(sliceChatBeforeOffset(chat, 1)[0], chat[0]);
    assert.deepEqual(sliceChatBeforeOffset(chat, 200), []);
    assert.equal(chat.length, 2);
});

test('offset uses full chat positions before hidden, OOC and tool filtering', () => {
    const chat = [{ name: 'Mirella', mes: 'One' }, { name: 'Mirella', mes: 'Hidden', is_system: true },
        { name: 'Mirella', mes: 'Three' }, { mes: 'OOC' }, { mes: 'Tool', extra: { type: 'tool_response' } }];
    const result = selectRpMessages(sliceChatBeforeOffset(chat, 2), { isOoc: text => text === 'OOC' });
    assert.deepEqual(result.map(message => message.mes), ['One', 'Three']);
    assert.deepEqual(formatAgentMessages(result, chat, { withIndices: true }),
        ['[message_index=1] Mirella: One', '[message_index=3] Mirella: Three']);
});

test('real agent context applies the same offset to normal and OOC execution without changing the chat', async () => {
    const ctx = { chat: Array.from({ length: 140 }, (_, i) => ({ name: `Speaker ${i + 1}`, mes: `Message ${i + 1}` })) };
    const before = structuredClone(ctx.chat);
    const sandbox = { selectRpMessages, sliceChatBeforeOffset, normalizeContextMessageOffset,
        SillyTavern: { getContext: () => ctx }, config: { characters: [] }, isBackstageOocMessage: () => false,
        SUMMARY_CREATION_TYPE: 'summary-creation', AGENT_OWNER_TYPES: { CHARACTER: 'character' },
        getAgentDependencies: () => [], getAgentCharacterReference: () => ({}),
        getCharacterPersonalityTagReferences: () => [], routerPromptUsesTag: () => false,
        getAgentRuntimeState: () => ({ output: '' }),
        formatAgentRpContext: (_agent, messages, context, withIndices) => formatAgentMessages(messages, context.chat, { withIndices }) };
    vm.createContext(sandbox);
    vm.runInContext(`${extract('getRpContextMessages')}\n${extract('buildAgentContextSnapshot')}`, sandbox);
    const agent = { id: 'test', name: 'Test', ownerType: 'global', prompt: '{{recentChat}}', contextMessages: 30, contextMessageOffset: 10 };
    for (const type of ['manual', 'character', 'ooc']) {
        const result = await sandbox.buildAgentContextSnapshot(agent, { type }, ctx);
        assert.equal(result.recentChatEntries.length, 30);
        assert.equal(result.recentChatEntries[0], 'Speaker 101: Message 101');
        assert.equal(result.recentChatEntries.at(-1), 'Speaker 130: Message 130');
        assert.equal(result.lastSpeaker, 'Speaker 130');
        assert.equal(result.contextMessageOffset, 10);
    }
    const legacy = await sandbox.buildAgentContextSnapshot({ ...agent, contextMessageOffset: undefined }, { type: 'manual' }, ctx);
    assert.equal(legacy.recentChatEntries.at(-1), 'Speaker 140: Message 140');
    assert.deepEqual(ctx.chat, before);
});
