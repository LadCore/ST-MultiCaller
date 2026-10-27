import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSummaryMemoryUsage } from '../memory/summary-usage.js';

const character = { name: 'Mirella Veyr', avatar: 'mirella.png' };

test('usage request includes only reference and exact selected messages, with no writes or truncation', async () => {
    const messages = [{ role: 'assistant', name: character.name, content: 'A chosen reply.' }];
    let sent;
    const result = await checkSummaryMemoryUsage('A memory.', messages, { fetchImpl: async (url, options) => {
        sent = { url, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({
            verdict: 'same_topic', usage_probability: 0.2, confidence: 0.3, evaluated_messages: 1,
            warnings: ['Test warning'], model: 'test-model',
        }) };
    } });
    assert.equal(sent.url, 'http://127.0.0.1:8091/usage/check');
    assert.deepEqual(sent.body, { reference: 'A memory.', messages });
    assert.equal(result.verdict, 'same_topic');
    assert.deepEqual(result.warnings, ['Test warning']);
});

test('backend and malformed-result errors are not interpreted as not_used', async () => {
    await assert.rejects(checkSummaryMemoryUsage('Memory', [], {
        fetchImpl: async () => ({ ok: false, status: 422, text: async () => 'Context too long' }),
    }), /422.*Context too long/);
    await assert.rejects(checkSummaryMemoryUsage('Memory', [{}], {
        fetchImpl: async () => ({ ok: true, json: async () => ({ verdict: 'not_used' }) }),
    }), /Invalid usage/);
});
