import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSummaryMemoryList, selectSummaryMemories, getMemoryWindow } from '../ui/summary-memory-list.js';

const escapeHtml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

test('groups inside before outside and sorts each group by chat position without changing source order', () => {
    const memories = [
        { text: 'Outside recent', included: false, last_relevant_message_index: 90 },
        { text: 'Inside recent', included: true, last_relevant_message_index: 80 },
        { text: 'Outside old', included: false, last_relevant_message_index: 10 },
        { text: 'Inside old', included: true, last_relevant_message_index: 20 },
        { text: 'Outside unknown', included: false, last_relevant_message_index: null, ratingError: 'Missing index' },
    ];
    const before = structuredClone(memories);
    const html = renderSummaryMemoryList({ allMemories: memories }, escapeHtml, 'all');
    const order = ['Inside old', 'Inside recent', 'Outside old', 'Outside recent', 'Outside unknown'];
    for (let index = 1; index < order.length; index++) assert(html.indexOf(order[index - 1]) < html.indexOf(order[index]));
    assert.match(html, /In box \(2\)/);
    assert.match(html, /Outside box \(3\)/);
    assert.match(html, /sd-summary-memory--invalid/);
    assert.deepEqual(memories, before);
});

test('initial filter includes only box memories and outside data remains available on demand', () => {
    const summary = { allMemories: [{ text: 'Selected', included: true }, { text: 'Outside', included: false }] };
    assert.deepEqual(selectSummaryMemories(summary).map(memory => memory.text), ['Selected']);
    assert.deepEqual(selectSummaryMemories(summary, 'outside').map(memory => memory.text), ['Outside']);
    assert.equal(selectSummaryMemories(summary, 'all').length, 2);
    assert.doesNotMatch(renderSummaryMemoryList(summary, escapeHtml), /Outside/);
});

test('virtual window bounds DOM rows across large lists and supports variable measured heights', () => {
    const heights = Array(1317).fill(300);
    const first = getMemoryWindow(heights, 0, 520);
    assert.equal(first.start, 0);
    assert(first.end < 10);
    assert.equal(first.before + heights.slice(first.start, first.end).reduce((a, b) => a + b, 0) + first.after, 1317 * 300);
    const last = getMemoryWindow(heights, 1317 * 300 - 520, 520);
    assert.equal(last.end, 1317);
    assert(last.start > 1300);
    assert.deepEqual(getMemoryWindow([], 0, 520), { start: 0, end: 0, before: 0, after: 0 });
    assert.equal(getMemoryWindow([100, 1000, 50], 150, 100, 0).start, 1);
});

test('empty groups are omitted and memory content remains escaped', () => {
    const html = renderSummaryMemoryList({ allMemories: [{ text: '<script>test</script>', included: true }] }, escapeHtml);
    assert.match(html, /&lt;script&gt;test&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /Outside box \(/);
    assert.match(renderSummaryMemoryList(null, escapeHtml), /No memories loaded/);
});
