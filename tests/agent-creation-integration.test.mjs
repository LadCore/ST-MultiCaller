import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSummaryCreation, SUMMARY_CREATION_TYPE } from '../memory/summary-creation.js';
import { selectRpMessages, normalizeContextMessageOffset } from '../agents/rp-context.js';
import { CancellationRegistry, isAbortError } from '../runtime/cancellation.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const extract = name => {
    const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert(body, name);
    return body;
};

/** Exercise the existing agent executor, not a separate summary-specific LLM implementation. */
function fixture({ invalid = false, failSave = false, trimmed = false } = {}) {
    const agent = { id: 'creation:mirella', name: 'Memory creation', internalType: SUMMARY_CREATION_TYPE,
        prompt: 'Summarize {{recentChat}}', contextMessages: 5, worldInfoBooks: [], interval: 3, maxToolRounds: 16 };
    const character = { name: 'Mirella', avatar: 'm.png', summary: { namespace: 'rp', groupId: 'mirella' } };
    const ctx = { chatMetadata: {}, chatId: 'rp', groupId: 'group', saveMetadata: async () => {},
        chat: [{ name: 'Mirella', mes: 'I escaped.' }] };
    const output = JSON.stringify({ memories: [{ title: 'Escape', bullet: 'I escaped.', descriptive: 'I escaped the maze.',
        importance: 3, last_relevant_message_index: 1 }] });
    const runtime = { pendingTurns: 3, output: 'Previous output' };
    const logs = [];
    let llmCalls = 0;
    const bodies = [];
    const creation = createSummaryCreation({ getContext: () => ctx, getCharacter: () => character,
        selectMessages: (_agent, context) => selectRpMessages(context.chat),
        fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            bodies.push(body);
            if (failSave && bodies.length === 1) throw new Error('API write timed out');
            return { ok: true, json: async () => ({ results: [{ kind: 'memory', id: 'saved',
                importance: body.importance, last_relevant_message_index: body.last_relevant_message_index,
                references: { n2: [{ text: body.descriptive }] } }], meta: {} }) };
        } });
    const noop = () => {};
    const sandbox = { SUMMARY_CREATION_TYPE, config: {}, SillyTavern: { getContext: () => ctx }, summaryCreation: creation,
        getAgentDefinition: () => agent, getChatContextKey: () => 'group:rp',
        getAgentOperationDisplayName: () => 'Mirella / Memory creation', getAgentLogScope: () => 'Agent',
        resolveAgentConnection: () => ({ profileId: 'inherited', label: 'Parent', source: 'parent' }),
        getTimingModelLabel: () => 'Model', runningAgentIds: new Set(),
        beginOperationLog: () => { logs.push({}); return 'log'; },
        updateOperationLog: (_id, patch) => Object.assign(logs.at(-1), patch),
        completeOperationLog: (_id, status) => { logs.at(-1).status = status; },
        appendOperationLogDetail: noop, refreshSceneDirectorPanel: noop, clearBackstageIssueIfSource: noop,
        cancellableOperations: new CancellationRegistry(), isAbortError,
        saveAgentRuntimeState: (_id, patch) => Object.assign(runtime, patch), getAgentRuntimeState: () => runtime,
        backstageLogger: { info: noop, debug: noop, error: noop }, sortScheduledAgents: noop,
        buildAgentContextSnapshot: async () => ({ creationInput: creation.prepare(agent, ctx), recentChatEntries: ['Mirella: I escaped.'] }),
        fitContextMessagesToInputBudget: async (_profile, context) => ({ context, trimmed,
            messages: [{ role: 'system', content: 'Memory input' }], budget: 1000, inputTokens: 100 }),
        buildAgentMessages: noop, formatAgentContextForLog: () => 'context', formatPromptMessages: JSON.stringify,
        getAgentDependencies: () => [], getAgentInjectionTargets: () => [], formatAgentInjectionPlacement: () => '',
        buildAgentGraphitiToolRuntime: () => null,
        sendAgentStreamingRequest: async profile => {
            assert.equal(profile, 'inherited'); llmCalls++; return { content: invalid ? 'Not JSON' : output };
        },
        stripMarkdownFence: text => text, extractResponseText: response => response.content,
        validateAgentOutput: () => ({ valid: true }), maybePersistAgentOutputSnapshot: async () => null,
        refreshSummaryAfterCreation: async () => {}, sceneDirectorState: {},
    };
    vm.createContext(sandbox);
    vm.runInContext(extract('executeAgent'), sandbox);
    return { sandbox, agent, runtime, logs, bodies, creation, llmCalls: () => llmCalls };
}

test('the native agent executor generates, registers and persists memory output with its inherited connection', async () => {
    const f = fixture();
    await f.sandbox.executeAgent(f.agent.id, { type: 'character', label: 'Automatic character schedule', consumedTurns: 3 });
    assert.equal(f.llmCalls(), 1);
    assert.equal(f.bodies.length, 1);
    assert.equal(f.runtime.lastStatus, 'success');
    assert.equal(f.runtime.pendingTurns, 0);
    assert.equal(f.logs[0].status, 'success');
    assert.equal(f.creation.getState(f.agent).lastSavedIndex, 1);
});

test('invalid JSON and truncated input never register memories or overwrite valid output', async () => {
    for (const options of [{ invalid: true }, { trimmed: true }]) {
        const f = fixture(options);
        await assert.rejects(f.sandbox.executeAgent(f.agent.id));
        assert.equal(f.bodies.length, 0);
        assert.equal(f.runtime.output, 'Previous output');
        assert.equal(f.runtime.lastStatus, 'error');
        assert.equal(f.sandbox.runningAgentIds.size, 0);
        if (options.invalid) {
            assert.equal(f.runtime.lastError, 'Memory creation requires valid JSON.');
            assert.match(f.logs[0].error, /LLM output \(original\):\nNot JSON/);
            assert.equal(f.sandbox.sceneDirectorState.persistentIssue, 'Memory creation requires valid JSON.');
        } else {
            assert.equal(f.logs[0].error, f.runtime.lastError);
            assert.doesNotMatch(f.runtime.lastError, /LLM output/);
            assert.doesNotMatch(f.runtime.lastError, /Previous output/);
        }
    }
});

test('retry-save uses the same native cancellation/log lifecycle but does not call the LLM again', async () => {
    const f = fixture({ failSave: true });
    await assert.rejects(f.sandbox.executeAgent(f.agent.id), /timed out/);
    assert.equal(f.runtime.output, 'Previous output');
    await f.sandbox.executeAgent(f.agent.id, { type: 'retry-save', label: 'Retry original save' });
    assert.equal(f.llmCalls(), 1);
    assert.equal(f.bodies.length, 2);
    assert.deepEqual(f.bodies[0], f.bodies[1]);
    assert.equal(f.runtime.lastStatus, 'success');
    assert.equal(f.runtime.lastError, '');
    assert.equal(f.logs.at(-1).status, 'success');
});

test('definition normalization persists hidden-message settings and disables unsupported internal capabilities', () => {
    const sandbox = { SUMMARY_CREATION_TYPE, normalizeContextMessageOffset,
        normalizeAgentId: value => value || 'id', createUniqueAgentId: () => 'id',
        AGENT_SCHEDULE_TYPES: new Set(['manual', 'character-turns']), AGENT_LOG_LEVEL_OPTIONS: ['inherit'],
        DEFAULT_AGENT_CONTEXT_MESSAGES: 100, DEFAULT_AGENT_MAX_TOOL_ROUNDS: 16, MAX_AGENT_TOOL_ROUNDS: 64,
        normalizeAgentInjectionPlacement: () => ({ position: 1, depth: 0, role: 0 }),
        normalizeAgentConnection: value => ({ ...value }), normalizeGraphitiGroupIds: () => [],
        isValidGraphitiGroupId: () => false, normalizeGraphitiPermissions: () => [], normalizeCharacterInjectionTargets: () => [] };
    vm.createContext(sandbox);
    vm.runInContext(extract('normalizeAgentDefinition'), sandbox);
    const raw = { id: 'creation:mirella', internalType: SUMMARY_CREATION_TYPE, ownerType: 'character',
        ownerCharacterAvatar: 'm.png', includeHiddenMessages: true, applyPromptRegex: true, scheduleType: 'character-turns', interval: 3,
        contextMessageOffset: 10, actionEnabled: true, graphitiAutomaticEnabled: true, characterInjectionEnabled: true };
    const restored = sandbox.normalizeAgentDefinition(JSON.parse(JSON.stringify(sandbox.normalizeAgentDefinition(raw))));
    assert.equal(restored.includeHiddenMessages, true);
    assert.equal(restored.applyPromptRegex, true);
    assert.equal(restored.contextMessageOffset, 10);
    assert.equal(restored.internalType, SUMMARY_CREATION_TYPE);
    assert.equal(restored.scheduleType, 'character-turns');
    assert.equal(restored.interval, 3);
    assert.equal(restored.actionEnabled, false);
    assert.equal(restored.graphitiAutomaticEnabled, false);
    assert.equal(restored.characterInjectionEnabled, false);
    assert.equal(sandbox.normalizeAgentDefinition({}).includeHiddenMessages, false);
    assert.equal(sandbox.normalizeAgentDefinition({}).applyPromptRegex, false);
    assert.equal(sandbox.normalizeAgentDefinition({}).contextMessageOffset, 0);
    assert.equal(sandbox.normalizeAgentDefinition({ actionEnabled: true }).actionEnabled, true);
});

test('character summary is substituted only through its explicit prompt tag, including OOC', () => {
    const sandbox = {
        SillyTavern: { getContext: () => ({}) },
        resolveAgentTagsInText: text => text,
        routerPromptUsesTag: (tag, text) => text.includes(`{{${tag}}}`),
        renderTemplate: (text, values) => text.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? ''),
    };
    vm.createContext(sandbox);
    vm.runInContext(extract('buildAgentMessages'), sandbox);
    const context = { promptTemplate: 'Existing memories:\n{{characterSummary}}',
        characterSummary: '<Summary>Only selected N2 memories.</Summary>' };
    for (const options of [{}, { mode: 'ooc', oocRequest: 'Check these memories.' }]) {
        const messages = sandbox.buildAgentMessages(context, options);
        assert.equal(messages[0].content, `Existing memories:\n${context.characterSummary}`);
    }
    assert.equal(sandbox.buildAgentMessages({ ...context, promptTemplate: 'No summary tag.' })[0].content, 'No summary tag.');
    assert.match(sandbox.buildAgentMessages({ ...context, characterSummary: '' })[0].content, /No character summary selected/);
});
