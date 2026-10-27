import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatAgentMessages } from '../agents/rp-context.js';

test('disabled prompt regex preserves existing formatting and user macros', () => {
    const messages = [{ name: 'Juliano', is_user: true, mes: '{{user}}: <private>hidden</private> Hello.' },
        { name: 'Mirella', mes: 'Answer.' }];
    const before = structuredClone(messages);
    assert.deepEqual(formatAgentMessages(messages, messages, { humanName: 'Juliano' }),
        ['Juliano: Juliano: <private>hidden</private> Hello.', 'Mirella: Answer.']);
    assert.deepEqual(messages, before);
});

test('regex transforms only copied content and keeps source indices, roles and prompt-relative depths', () => {
    const notice = { name: 'System', is_system: true, mes: 'Host notice' };
    const messages = [{ name: 'Juliano', is_user: true, mes: '<private>hidden</private> Hello.' },
        { name: 'Mirella', is_system: true, mes: 'Reply <private>hidden</private>.' }];
    const chat = [notice, ...messages];
    const before = structuredClone(chat);
    const calls = [];
    const result = formatAgentMessages(messages, chat, { withIndices: true,
        regexTransform: (text, isUser, depth) => {
            calls.push({ isUser, depth });
            return text.replace(/<private>.*?<\/private>/g, '');
        } });
    assert.deepEqual(result, ['[message_index=2] Juliano:  Hello.', '[message_index=3] Mirella: Reply .']);
    assert.deepEqual(calls, [{ isUser: true, depth: 1 }, { isUser: false, depth: 0 }]);
    assert.deepEqual(chat, before);
});

test('agent adapter calls the ST native prompt engine only when enabled, including the creation format', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const body = source.match(/function formatAgentRpContext\([^]*?\n\}/)?.[0];
    assert(body);
    const calls = [];
    const sandbox = { formatAgentMessages, regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
        getRegexedString: (text, placement, options) => {
            calls.push({ placement, ...options }); return text.replace('secret', 'clean');
        } };
    vm.createContext(sandbox);
    vm.runInContext(body, sandbox);
    const ctx = { name1: 'Juliano', chat: [{ name: 'Juliano', is_user: true, mes: 'secret' },
        { name: 'Mirella', mes: 'secret' }] };
    sandbox.formatAgentRpContext({}, ctx.chat, ctx);
    assert.equal(calls.length, 0);
    const result = sandbox.formatAgentRpContext({ applyPromptRegex: true }, ctx.chat, ctx, true);
    assert.deepEqual(result, ['[message_index=1] Juliano: clean', '[message_index=2] Mirella: clean']);
    assert.deepEqual(calls, [{ placement: 1, isPrompt: true, depth: 1 }, { placement: 2, isPrompt: true, depth: 0 }]);
    assert.equal(ctx.chat[0].mes, 'secret');
});
