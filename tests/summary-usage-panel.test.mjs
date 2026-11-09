import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryUsagePanel, buildSemanticTestRows } from '../ui/summary-usage.js';
import { summarySourceKey } from '../memory/character-summary.js';
import { sortMemoryRows, renderMemoryRows, SEMANTIC_COLUMNS } from '../ui/memory-results-table.js';

const escapeHtml = value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const candidates = [{ id: 'outside', n1: 'Old memory', matches: [{ fact_id: 'fact', similarity: 0.87 }] }];

/** Exercise the real cache/rating selection with no browser or backend writes. */
function fixture(t, findCandidates = async () => ({ candidates })) {
    const previous = globalThis.document;
    globalThis.document = { querySelector: () => null, getElementById: () => null };
    t.after(() => { globalThis.document = previous; });
    const character = { name: 'Mirella', avatar: 'm.png', summary: { namespace: 'rp', groupId: 'mirella', minRating: 0.5,
        reinforcement: { minSimilarity: 0.6, candidateLimit: 25 } } };
    const owner = { key: 'm.png', character };
    const ctx = { chat: Array(1000), chatMetadata: { sceneDirector: { characterSummaries: {
        'm.png': { sourceKey: summarySourceKey(character), allMemories: [
            { id: 'inside', text: 'Recent memory', importance: 5, last_relevant_message_index: 1000 },
            { id: 'outside', text: 'Old memory', importance: 1, last_relevant_message_index: 1 }] },
    } } } };
    const calls = [];
    const panel = createSummaryUsagePanel({ getContext: () => ctx, getOwner: () => owner, escapeHtml,
        findCandidates: (...args) => { calls.push(args); return findCandidates(...args); } });
    panel.updateDraft('Exact RP text');
    return { panel, ctx, owner, calls, html: () => panel.render(owner) };
}

test('one semantic request uses configured cutoff and group without changing cache', async t => {
    const f = fixture(t), before = structuredClone(f.ctx);
    assert.match(f.html(), /data-summary-field="reinforcement.minSimilarity" value="0.6"/);
    await f.panel.run();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0][0], { namespace: 'rp', group_id: 'mirella', character: 'Mirella' });
    assert.equal(f.calls[0][1], 'Exact RP text');
    assert.equal(f.calls[0][2], 25);
    assert.equal(f.calls[0][3].minSimilarity, 0.6);
    assert.match(f.html(), /1 returned memories · 2 displayed/);
    f.panel.updateScope('outside');
    assert.match(f.html(), /1 returned memories · 1 displayed/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.ctx, before);
    assert.doesNotMatch(f.html(), /P\(used\)|Confidence/);
});

test('empty search succeeds and does not claim verified non-use', async t => {
    const f = fixture(t, async () => ({ candidates: [] }));
    await f.panel.run();
    assert.match(f.html(), /0 returned memories · 2 displayed/);
    assert.doesNotMatch(f.html(), /not_used/);
});

test('Usage sends speech only while preserving the original draft and request diagnostics', async t => {
    const f = fixture(t);
    const draft = '*looks away* Remember *sighs* Aiko?';
    f.panel.updateDraft(draft);
    await f.panel.run();
    assert.equal(f.calls[0][1], 'Remember Aiko?');
    assert.match(f.html(), /\*looks away\* Remember \*sighs\* Aiko\?/);
    assert.match(f.html(), /"query": "Remember Aiko\?"/);
    f.panel.updateDraft('*stays silent*');
    await f.panel.run();
    assert.equal(f.calls.length, 1);
    assert.match(f.html(), /Enter text to search outside/);
});

test('stopping discards late results and forwards abort signal', async t => {
    let release;
    const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
    const running = f.panel.run();
    f.panel.stop();
    assert.equal(f.calls[0][3].signal.aborted, true);
    release({ candidates });
    await running;
    assert.match(f.html(), /Test stopped/);
    assert.doesNotMatch(f.html(), /returned memories/);
});

test('errors remain errors rather than negative retrieval results', async t => {
    const f = fixture(t, async () => { throw new Error('Backend unavailable'); });
    await f.panel.run();
    assert.match(f.html(), /Backend unavailable/);
    assert.doesNotMatch(f.html(), /returned memories/);
});

test('changed settings discard in-flight results', async t => {
    let release;
    const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
    const running = f.panel.run();
    f.owner.character.summary.groupId = 'other';
    release({ candidates });
    await running;
    assert.match(f.html(), /settings changed/);
});

test('returned uncached memories stay unknown and native scores remain unaggregated', () => {
    const rows = buildSemanticTestRows({ allMemories: [{ id: 'known', text: 'Known', included: true }] }, candidates);
    assert.equal(rows[0].memory.loaded, false);
    assert.equal(rows[1].returned, false);
    assert.deepEqual(rows[0].matches, candidates[0].matches);
    const html = renderMemoryRows(rows, SEMANTIC_COLUMNS, escapeHtml);
    assert.match(html, /Not loaded/);
    assert.match(html, /Not returned/);
    assert.match(html, /0.87/);
    assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test('numeric sorting keeps missing values last and does not mutate input', () => {
    const rows = [0.9, null, 0.12, NaN].map(rating => ({ memory: { rating } }));
    assert.deepEqual(sortMemoryRows(rows, { column: 'rating', direction: 'asc' }).slice(0, 2).map(row => row.memory.rating), [0.12, 0.9]);
    assert.deepEqual(sortMemoryRows(rows, { column: 'rating', direction: 'desc' }).slice(0, 2).map(row => row.memory.rating), [0.9, 0.12]);
    assert.equal(rows[0].memory.rating, 0.9);
});
