import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { findReinforcementCandidates, patchMemoryBoost } from '../memory/memorybox-client.js';
import { createMemoryReinforcementLogger } from '../logging/memory-reinforcement.js';

const scope = { namespace: 'rp', group_id: 'mirella', character: 'Mirella Veyr' };
const boost = { value: 0.35, message_index: 9500 };
const reference = { id: 'episode-one', text: 'A scoped N2.', importance: 4, last_relevant_message_index: 1, boost: null };
const response = data => ({ ok: true, json: async () => data });

test('confirmed outside use shows a dismissible persistent toast, not a transient search notice', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const body = source.match(/function notifyOutsideMemoryUse\([^]*?\n\}/)?.[0];
    assert(body);
    const calls = [];
    const sandbox = { toastr: { info: (...args) => calls.push(args) } };
    vm.createContext(sandbox);
    vm.runInContext(body, sandbox);
    sandbox.notifyOutsideMemoryUse({ stage: 'search-result' });
    assert.equal(calls.length, 0);
    sandbox.notifyOutsideMemoryUse({ stage: 'outside-memory-used', character: 'Mirella', text: '<b>A memory</b>',
        result: { usage_probability: 0.95, confidence: 0.9 } });
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /95.0%.*90.0%/);
    assert.match(calls[0][1], /Mirella/);
    assert.equal(calls[0][2].timeOut, 0);
    assert.equal(calls[0][2].extendedTimeOut, 0);
    assert.equal(calls[0][2].closeButton, true);
    assert.equal(calls[0][2].tapToDismiss, false);
    assert.equal(calls[0][2].escapeHtml, true);
});

test('semantic retrieval deduplicates episode references and sends only scoped query parameters', async () => {
    let body;
    const result = await findReinforcementCandidates(scope, 'A character reply.', 25, {
        fetchImpl: async (_url, options) => {
            body = JSON.parse(options.body);
            return response({ results: [
                { kind: 'fact', id: 'fact-one', references: { n2: [reference] } },
                { kind: 'fact', id: 'fact-two', references: { n2: [reference] } },
            ], meta: { partial: false, warnings: [] } });
        },
    });
    assert.deepEqual(body, { ...scope, query: 'A character reply.', limit: 25 });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].id, 'episode-one');
});

test('PATCH writes boost only, validates confirmation and never retries HTTP failures', async () => {
    let calls = 0;
    const result = await patchMemoryBoost(scope, reference.id, boost, {
        fetchImpl: async (url, options) => {
            calls++;
            assert.equal(url, 'http://127.0.0.1:8091/memorybox/nodes/episode-one');
            assert.equal(options.method, 'PATCH');
            assert.deepEqual(JSON.parse(options.body), { ...scope, boost });
            return response({ results: [{ kind: 'memory', ...reference, boost,
                references: { n2: [reference] } }], meta: { partial: false } });
        },
    });
    assert.equal(result.boost.value, 0.35);
    assert.equal(result.importance, 4);
    assert.equal(result.last_relevant_message_index, 1);
    await assert.rejects(patchMemoryBoost(scope, reference.id, boost, {
        fetchImpl: async () => { calls++; return { ok: false, status: 409, text: async () => 'Conflict' }; },
    }), /409/);
    assert.equal(calls, 2);
});

test('detailed events are mirrored to the console and Operation History', t => {
    const consoleRows = [];
    t.mock.method(console, 'info', (...args) => consoleRows.push(args));
    const logs = [];
    const sink = createMemoryReinforcementLogger({
        appendOperationLog: entry => { logs.push({ ...entry, id: 'log' }); return 'log'; },
        updateOperationLog: (_id, patch) => Object.assign(logs[0], patch),
        completeOperationLog: (_id, status) => Object.assign(logs[0], { status }),
    });
    const common = { runId: 'run', character: 'Mirella Veyr', message_index: 9500, level: 'info' };
    sink({ ...common, stage: 'start', settings: { minRating: 0.5 } });
    sink({ ...common, stage: 'patch-request', request: { ...scope, boost } });
    sink({ ...common, stage: 'finish', status: 'success', outcomes: [{ action: 'boosted' }] });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.match(logs[0].request, /9500/);
    assert.match(logs[0].response, /boosted/);
    assert.equal(consoleRows.length, 3);
    assert.match(consoleRows[0][0], /MemoryBoost:Mirella Veyr/);
});

test('live progress shows concurrent pending checks and final counts', async t => {
    t.mock.method(console, 'info', () => {});
    t.mock.method(console, 'error', () => {});
    const rows = [];
    const sink = createMemoryReinforcementLogger({
        appendOperationLog: entry => { rows.push(entry); return 'progress'; },
        updateOperationLog: (_id, patch) => Object.assign(rows[0], patch),
        completeOperationLog: (_id, status) => { rows[0].status = status; },
    });
    const common = { runId: 'progress', character: 'Mirella', message_index: 10, level: 'info' };
    const emit = (stage, rest = {}) => sink({ ...common, stage, ...rest });
    emit('start');
    emit('search-request');
    emit('search-result', { candidates: [{ id: 'a' }, { id: 'b' }] });
    emit('usage-request', { memoryId: 'a' });
    emit('usage-request', { memoryId: 'b' });
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.match(rows[0].detail, /Verifying memory use.*2 candidates.*0\/2 checked.*2 pending/);
    emit('usage-result', { memoryId: 'a' });
    emit('candidate-complete', { memoryId: 'a', action: 'boosted' });
    emit('candidate-error', { memoryId: 'b', level: 'error', error: 'Usage timeout' });
    emit('finish', { status: 'error', error: 'Usage timeout' });
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /Finished: error.*1\/2 checked.*0 pending.*1 boosted.*1 failed/);
    assert.match(rows[0].error, /Usage timeout/);
});

test('disabled search progress hides successful runs but still records errors', t => {
    const consoleRows = [];
    t.mock.method(console, 'info', (...args) => consoleRows.push(args));
    t.mock.method(console, 'error', (...args) => consoleRows.push(args));
    const rows = [];
    let enabled = false;
    const sink = createMemoryReinforcementLogger({
        isProgressEnabled: () => enabled,
        appendOperationLog: entry => { rows.push(entry); return rows.length - 1; },
        updateOperationLog: (id, patch) => Object.assign(rows[id], patch),
        completeOperationLog: (id, status) => { rows[id].status = status; },
    });
    const common = { character: 'Mirella', message_index: 10, level: 'info' };
    sink({ ...common, runId: 'hidden', stage: 'start' });
    sink({ ...common, runId: 'hidden', stage: 'finish', status: 'success' });
    assert.equal(rows.length, 0);
    assert.equal(consoleRows.length, 0);
    sink({ ...common, runId: 'error', stage: 'start' });
    sink({ ...common, runId: 'error', stage: 'run-error', level: 'error', error: 'Search failed' });
    sink({ ...common, runId: 'error', stage: 'finish', status: 'error', error: 'Search failed' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
    assert.match(rows[0].error, /Search failed/);
    assert.equal(consoleRows.length, 1);
    enabled = true;
    sink({ ...common, runId: 'enabled', stage: 'start' });
    sink({ ...common, runId: 'enabled', stage: 'finish', status: 'success' });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, 'success');
});

test('memory-search log option survives native settings roundtrip and legacy defaults stay enabled', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const sandbox = { structuredClone, CURRENT_CONFIG_VERSION: 1, NATIVE_SETTINGS_STORAGE_VERSION: 1,
        DEFAULT_ROUTER_PROMPT: '', DEFAULT_CONFIG: { consoleLogLevel: 'debug' },
        config: { characters: [], agents: [], memorySearchLogs: false },
        normalizeLogLevel: value => value, normalizeCharacterConnection: value => value,
        normalizeAgentDefinitions: value => value ?? [] };
    vm.createContext(sandbox);
    for (const name of ['buildNativeRouterAgentConfig', 'applyNativeRouterAgentConfig']) {
        const body = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
        assert(body);
        vm.runInContext(body, sandbox);
    }
    const saved = sandbox.buildNativeRouterAgentConfig();
    assert.equal(saved.logging.memorySearches, false);
    sandbox.config.memorySearchLogs = true;
    sandbox.applyNativeRouterAgentConfig(saved);
    assert.equal(sandbox.config.memorySearchLogs, false);
    delete sandbox.config.memorySearchLogs;
    sandbox.applyNativeRouterAgentConfig({});
    assert.equal(sandbox.config.memorySearchLogs, true);
});

test('log header summarizes found memories, used probabilities, thresholds and confirmed boosts', t => {
    t.mock.method(console, 'info', () => {});
    const rows = [];
    const sink = createMemoryReinforcementLogger({
        appendOperationLog: entry => { rows.push(entry); return 'summary'; },
        updateOperationLog: (_id, patch) => Object.assign(rows[0], patch),
        completeOperationLog: (_id, status) => { rows[0].status = status; },
    });
    const common = { runId: 'summary', character: 'Mirella', message_index: 10, level: 'info' };
    const emit = (stage, rest = {}) => sink({ ...common, stage, ...rest });
    emit('start');
    emit('search-result', { found: 9, candidates: [
        { id: 'accepted', text: 'I remember Aiko during our escape.' },
        { id: 'low-confidence', text: 'The silver collar.' },
        { id: 'unrelated', text: 'Unrelated event.' },
    ] });
    emit('usage-result', { memoryId: 'low-confidence',
        result: { verdict: 'used', usage_probability: 0.82, confidence: 0.6 },
        decision: { accepted: false, reasons: ['confidence=0.6 below 0.8'] } });
    emit('candidate-complete', { memoryId: 'low-confidence', action: 'rejected' });
    emit('usage-result', { memoryId: 'accepted',
        result: { verdict: 'used', usage_probability: 0.95, confidence: 0.91 }, decision: { accepted: true } });
    emit('candidate-complete', { memoryId: 'accepted', action: 'boosted' });
    emit('usage-result', { memoryId: 'unrelated',
        result: { verdict: 'same_topic', usage_probability: 0.2, confidence: 0.9 }, decision: { accepted: false } });
    emit('finish', { status: 'success' });
    const header = rows[0].detail;
    assert.match(header, /9 memories found; 3 selected/);
    assert.match(header, /Used: 2 of 3 verified/);
    assert.match(header, /P\(used\): 95.0% \| Confidence: 91.0%/);
    assert.match(header, /I remember Aiko during our escape/);
    assert.match(header, /Boost saved/);
    assert.match(header, /P\(used\): 82.0% \| Confidence: 60.0%/);
    assert.match(header, /Thresholds not met: confidence=0.6 below 0.8/);
    assert(header.indexOf('Memory: accepted') < header.indexOf('Memory: low-confidence'));
    assert(!header.includes('Unrelated event.'));
    const events = JSON.parse(rows[0].response);
    assert(!('outcome' in events.find(event => event.stage === 'usage-result')),
        'The readable summary must not mutate recorded API events');
});

test('empty search and a search with no used verdicts are explicit in the header', t => {
    t.mock.method(console, 'info', () => {});
    for (const candidates of [[], [{ id: 'a', text: 'A memory.' }]]) {
        let row;
        const sink = createMemoryReinforcementLogger({ appendOperationLog: entry => { row = entry; return 'empty'; },
            updateOperationLog: (_id, patch) => Object.assign(row, patch), completeOperationLog: () => {} });
        const common = { runId: 'empty', character: 'Mirella', level: 'info', message_index: 1 };
        sink({ ...common, stage: 'search-result', candidates });
        if (candidates.length) sink({ ...common, stage: 'usage-result', memoryId: 'a',
            result: { verdict: 'not_used', usage_probability: 0.01, confidence: 0.99 } });
        sink({ ...common, stage: 'finish', status: 'success' });
        assert.match(row.detail, new RegExp(`${candidates.length} memories found`));
        assert.match(row.detail, /No used verdicts received/);
        assert.match(row.detail, new RegExp(`Used: 0 of ${candidates.length} verified`));
    }
});
