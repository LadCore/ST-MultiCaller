import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSummaryInjection, fetchCharacterSummary, getCharacterSummary, normalizeSummaryConfig, saveCharacterSummary,
} from '../memory/character-summary.js';
import { normalizeCharacterConnection } from '../agents/connection-routing.js';
import { createCharacterSummaryPanel } from '../ui/character-summary.js';

const character = () => ({
    name: 'Mirella Veyr', avatar: 'mirella.png',
    summary: { namespace: 'test-rp', groupId: 'mirella', minRating: 0.5, enabled: true },
});
const memory = (id, rating, text = `N2 ${id}`) => ({
    kind: 'memory', id, rating, importance: rating < 0.5 ? 1 : rating < 0.9 ? 3 : 5,
    last_relevant_message_index: 1,
    references: { n1: [{ text: 'Do not include N1' }], n2: [{ id, text }] },
});
const response = (results, next = null, extras = {}) => ({
    ok: true, json: async () => ({ results, meta: { next_offset: next, warnings: [], partial: false, ...extras } }),
});
const snapshot = text => ({ allMemories: [{ id: 'one', text, importance: 5, last_relevant_message_index: 1 }] });

test('pages, filters inclusively, deduplicates IDs and builds N2-only text in rating order', async () => {
    const requests = [];
    const pages = [response([memory('low', 0.1), memory('a', 0.5)], 2), response([memory('a', 0.5), memory('b', 0.9)])];
    const result = await fetchCharacterSummary(character(), { currentMessageIndex: 1, fetchImpl: async (url, options) => {
        requests.push({ url, payload: JSON.parse(options.body) });
        return pages.shift();
    } });
    assert.equal(result.text, 'N2 a\n\nN2 b');
    assert.deepEqual(result.memories.map(item => item.id), ['a', 'b']);
    assert.equal(requests[1].payload.offset, 2);
    assert.equal(requests[0].payload.character, 'Mirella Veyr');
    assert.equal(requests[0].payload.namespace, 'test-rp');
    assert.equal(requests[0].payload.group_id, 'mirella');
    assert.equal(requests[0].url, 'http://127.0.0.1:8091/memorybox/by-rating');
});

test('empty selection succeeds, but missing N2, partial data and broken pagination fail', async () => {
    assert.equal((await fetchCharacterSummary(character(), { fetchImpl: async () => response([]) })).text, '');
    for (const page of [response([memory('a', 1, '')]), response([], null, { partial: true }), response([], 0)]) {
        await assert.rejects(fetchCharacterSummary(character(), { fetchImpl: async () => page }));
    }
});

test('HTTP errors and invalid configuration fail without writing metadata', async () => {
    await assert.rejects(fetchCharacterSummary(character(), {
        fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'backend offline' }),
    }), /502.*backend offline/);
    await assert.rejects(fetchCharacterSummary({ name: 'Mirella' }), /Namespace/);
});

test('summary metadata is isolated by chat and character; placement uses the agent contract', () => {
    let saves = 0;
    const ctx = { chatMetadata: {}, chat: Array(1), saveMetadata: () => saves++ };
    const char = character();
    saveCharacterSummary(ctx, char, snapshot('Only N2'));
    assert.equal(saves, 1);
    assert.equal(getCharacterSummary({ chatMetadata: {} }, char), null);
    assert.equal(getCharacterSummary(ctx, { ...char, avatar: 'other.png' }), null);
    const injection = buildSummaryInjection(ctx, char);
    assert.equal(injection.prompt, '<Summary>\nOnly N2\n</Summary>');
    assert.equal(injection.agent.characterInjectionPosition, 'in-chat');
    assert.equal(injection.agent.characterInjectionRole, 0);
    char.summary.characterInjectionPosition = 'after-main';
    assert.equal(buildSummaryInjection(ctx, char).agent.characterInjectionPosition, 'after-main');
    char.summary.enabled = false;
    assert.equal(buildSummaryInjection(ctx, char), null);
});

test('changed source cannot inject a stale summary', () => {
    for (const [key, value] of [['groupId', 'other'], ['namespace', 'other']]) {
        const char = character();
        const ctx = { chatMetadata: {} };
        saveCharacterSummary(ctx, char, { text: 'Old', memories: [] });
        char.summary[key] = value;
        assert.equal(buildSummaryInjection(ctx, char), null);
    }
});

test('connection normalization preserves summary settings across config reloads', () => {
    const stored = normalizeCharacterConnection(character());
    assert.deepEqual(normalizeCharacterConnection(JSON.parse(JSON.stringify(stored))).summary, stored.summary);
    const normalized = normalizeSummaryConfig({ minRating: 'invalid', characterInjectionPosition: 'after-main', characterInjectionRole: 2 });
    assert.equal(normalized.minRating, 0);
    assert.equal(normalized.characterInjectionRole, 0);
});

test('previously saved summaries also display and inject in ascending order without mutating storage', () => {
    const char = character();
    const ctx = { chatMetadata: {}, chat: Array(1) };
    saveCharacterSummary(ctx, char, {
        allMemories: [
            { id: 'high', importance: 5, last_relevant_message_index: 1, text: 'High' },
            { id: 'low', importance: 3, last_relevant_message_index: 1, text: 'Low' },
        ],
        text: 'High\n\nLow',
    });
    assert.equal(getCharacterSummary(ctx, char).text, 'Low\n\nHigh');
    assert.equal(buildSummaryInjection(ctx, char).prompt, '<Summary>\nLow\n\nHigh\n</Summary>');
    assert.equal(ctx.chatMetadata.sceneDirector.characterSummaries[char.avatar].text, 'High\n\nLow');
});

test('failed refresh preserves the previous summary and a successful retry clears its local error', async () => {
    const char = character();
    const ctx = { chatMetadata: {}, chat: Array(1) };
    const errors = [];
    saveCharacterSummary(ctx, char, snapshot('Previous'));
    let fails = true;
    const panel = createCharacterSummaryPanel({
        getContext: () => ctx, getOwner: () => ({ key: 'mirella', character: char }),
        saveConfig() {}, refresh() {}, reportError: (_source, error) => errors.push(error), escapeHtml: String,
        fetchSummary: async () => {
            if (fails) throw new Error('offline');
            return snapshot('Updated');
        },
    });
    await panel.load();
    assert.equal(getCharacterSummary(ctx, char).text, 'Previous');
    assert.match(panel.render({ key: 'mirella', character: char }), /offline/);
    fails = false;
    await panel.load();
    assert.equal(getCharacterSummary(ctx, char).text, 'Updated');
    assert.doesNotMatch(panel.render({ key: 'mirella', character: char }), /offline/);
    assert.deepEqual(errors, ['offline']);
});

test('legacy cached ratings cannot bypass the calculation or be injected before a full refresh', () => {
    const char = character();
    const ctx = { chatMetadata: {}, chat: Array(1) };
    saveCharacterSummary(ctx, char, { text: 'Legacy text', memories: [{ id: 'old', text: 'Legacy text', rating: 999 }] });
    const summary = getCharacterSummary(ctx, char);
    assert.equal(summary.needsRefresh, true);
    assert.equal(summary.allMemories[0].rating, null);
    assert.equal(summary.text, '');
    assert.equal(buildSummaryInjection(ctx, char), null);
});

test('a null backend rating does not prevent a valid importance-based score', async () => {
    const result = await fetchCharacterSummary(character(), {
        currentMessageIndex: 1,
        fetchImpl: async () => response([{ ...memory('valid', 1), rating: null }]),
    });
    assert.equal(result.memories[0].rating, 1);
});

test('refresh cannot overlap for the same character or persist into another chat', async () => {
    const char = character();
    const original = { chatMetadata: {}, chatId: 'a' };
    let ctx = original;
    let resolve;
    let calls = 0;
    const errors = [];
    const panel = createCharacterSummaryPanel({
        getContext: () => ctx, getOwner: () => ({ key: 'mirella', character: char }),
        saveConfig() {}, refresh() {}, reportError: (_source, error) => errors.push(error), escapeHtml: String,
        fetchSummary: () => { calls++; return new Promise(done => { resolve = done; }); },
    });
    const pending = panel.load();
    await panel.load();
    assert.equal(calls, 1);
    ctx = { chatMetadata: {}, chatId: 'b' };
    resolve({ text: 'Wrong chat', memories: [] });
    await pending;
    assert.equal(getCharacterSummary(ctx, char), null);
    assert.equal(getCharacterSummary(original, char), null);
    assert.match(errors[0], /Chat changed/);
});
