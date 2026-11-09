import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMemoryReinforcement } from '../memory/reinforcement-runner.js';
import { getCharacterSummary, saveCharacterSummary } from '../memory/character-summary.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const triggerSource = source.match(/async function triggerChar\([^]*?\n\}/)?.[0];
assert(triggerSource, 'The test must exercise the actual native trigger function');

/** Run the real trigger path with a real reinforcement runner and controlled host/API boundaries. */
function pipelineFixture({ failCheck = false } = {}) {
    const steps = [];
    const character = { name: 'Mirella Veyr', avatar: 'mirella.png', profileName: 'MC',
        summary: { namespace: 'rp', groupId: 'mirella', minRating: 0.5,
            enabled: true, reinforcement: { enabled: true } } };
    const memory = { id: 'memory', text: 'An old memory.', importance: 1, last_relevant_message_index: 1 };
    const ctx = { chatMetadata: {}, chat: [...Array(999), { name: character.name, mes: 'Previous reply.' },
        { name: 'Juliano', is_user: true, mes: 'Remember Aiko?' }, { name: 'Tio Klarus', mes: 'I remember her.' }],
        chatId: 'rp', groupId: 'group', saveMetadata: async () => {} };
    saveCharacterSummary(ctx, character, { allMemories: [memory] });
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const engine = createMemoryReinforcement({
        getContext: () => ctx, getCharacters: () => [character],
        findCandidates: async (_scope, query) => {
            steps.push('search');
            assert.match(query, /Juliano: Remember Aiko\?/);
            assert.match(query, /Tio Klarus: I remember her\./);
            entered();
            await gate;
            if (failCheck) throw new Error('Verifier offline');
            return { candidates: [{ id: memory.id, n1: 'Old memory', matches: [{ fact_id: 'fact', similarity: 0.9 }] }] };
        },
        readMemory: async () => structuredClone(memory),
        patchBoost: async (_scope, _id, boost) => { steps.push('patch'); return { ...memory, boost }; },
    });
    const noop = () => {};
    const sandbox = { DOMException,
        SillyTavern: { getContext: () => ctx },
        memoryReinforcement: engine,
        lastActiveChar: null,
        fl: noop, backstageLogger: { info: noop, debug: noop },
        runAgentsBeforeCharacter: async () => { steps.push('agents'); },
        resolveCharacterProfileForSwitch: () => ({ profileName: 'MC', source: 'profileName' }),
        buildChatRecoveryAnchor: () => ({}),
        beginTriggerSettleMonitor: () => ({ armRecovery: noop, promise: Promise.resolve({
            status: 'settled', events: [{ name: 'CHAT_CHANGED' }],
        }) }),
        setCharacterNote: noop, setDirectedOocPrompt: noop,
        applyAgentCharacterInjection: () => {
            steps.push('injection');
            sandbox.injectedSummary = getCharacterSummary(ctx, character).injectionText;
            return { applied: [], errors: [] };
        },
        beginRuntimePhase: noop, getTimingModelLabel: () => 'model', getActiveOperationLogId: () => 'turn',
        appendOperationLogDetail: noop, formatTriggerSettleForLog: noop, formatHostChatSummaryForLog: noop,
        summarizeHostChatForLog: noop, sceneDirectorState: {}, updateRouterState: noop,
        activeCharacterGenerationGuard: null, isAbortError: error => error.name === 'AbortError',
        PROFILE_SWITCH_SETTLE_QUIET_MS: 2000, PROFILE_SWITCH_SETTLE_MAX_WAIT_MS: 12000,
        cancellableOperations: { assertActive: operation => operation.controller.signal.throwIfAborted() },
    };
    ctx.executeSlashCommandsWithOptions = async command => {
        if (command.startsWith('/profile')) steps.push('profile');
        else {
            assert(command.startsWith('/trigger await=true'));
            steps.push('trigger');
            sandbox.activeCharacterGenerationGuard.interceptorCalls++;
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(triggerSource, sandbox);
    return { sandbox, character, steps, started, release, engine };
}

test('native pipeline retrieves SideBox after profile settle and injects it without a pre-turn boost', async () => {
    const f = pipelineFixture();
    const pending = f.sandbox.triggerChar(f.character);
    await f.started;
    assert.deepEqual(f.steps, ['agents', 'profile', 'search']);
    f.release();
    await pending;
    assert.deepEqual(f.steps, ['agents', 'profile', 'search', 'injection', 'trigger']);
    assert.equal(f.sandbox.injectedSummary, 'An old memory.');
});

test('a verifier failure is visible in reinforcement status without blocking native generation', async () => {
    const f = pipelineFixture({ failCheck: true });
    const pending = f.sandbox.triggerChar(f.character);
    await f.started;
    f.release();
    await pending;
    assert.match(f.engine.getStatus(f.character).lastError, /Verifier offline/);
    assert.equal(f.steps.includes('patch'), false);
    assert.equal(f.steps.at(-1), 'trigger');
});

test('operator cancellation during checks does not proceed to injection or character generation', async () => {
    const f = pipelineFixture();
    const controller = new AbortController();
    const pending = f.sandbox.triggerChar(f.character, null, { cancellation: { controller } });
    await f.started;
    controller.abort();
    f.release();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(f.steps.includes('injection'), false);
    assert.equal(f.steps.includes('trigger'), false);
});

test('directed OOC bypasses automatic reinforcement', async () => {
    const f = pipelineFixture();
    await f.sandbox.triggerChar(f.character, null, { directOocText: 'OOC test' });
    assert.deepEqual(f.steps, ['profile', 'injection', 'trigger']);
});

test('native completed-message handling waits for the SideBox comparison before scheduling the router', async () => {
    const f = pipelineFixture();
    const pending = f.sandbox.triggerChar(f.character);
    await f.started;
    f.release();
    await pending;
    const ctx = f.sandbox.SillyTavern.getContext();
    const reply = { name: f.character.name, mes: 'Juliano: Remember Aiko? Tio Klarus: I remember her.' };
    ctx.chat.push(reply);
    Object.assign(f.sandbox, { handledCharacterTurnMessages: new WeakSet(), pendingNativeCharacterMessage: null,
        isHostGenerationActive: async () => false, isToolInvocationChatMessage: () => false,
        scheduleAgentsForTurn: () => f.steps.push('scheduled'), skipNextCharacterAutoRouter: false,
        runRouter: () => f.steps.push('router') });
    const processSource = source.match(/async function processCompletedCharacterMessage\([^]*?\n\}/)?.[0];
    assert(processSource);
    vm.runInContext(processSource, f.sandbox);
    await f.sandbox.processCompletedCharacterMessage(reply, 'test');
    assert.deepEqual(f.steps.slice(-4), ['search', 'patch', 'scheduled', 'router']);
    assert.equal(getCharacterSummary(ctx, f.character).sideMemories.length, 0);
    await f.sandbox.processCompletedCharacterMessage(reply, 'duplicate');
    assert.equal(f.steps.filter(step => step === 'patch').length, 1);
});
