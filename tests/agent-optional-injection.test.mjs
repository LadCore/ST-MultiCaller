import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

/** Exercise the production parser, validator and delivery builder without ST or model calls. */
function fixture() {
    const targets = ['GM', 'Mirella', 'Tio'].map(name => ({ characterName: name, characterAvatar: `${name}.png`,
        mode: 'tag', tag: name, optional: name !== 'GM' }));
    const agent = { id: 'test', name: 'Test', ownerType: 'global', characterInjectionEnabled: true,
        characterInjectionTargets: targets, validateOutputFormat: false,
        prompt: 'OUTPUT FORMAT\n<GM><Note>Text</Note></GM><Mirella><Note>Text</Note></Mirella><Tio>Text</Tio>' };
    const ctx = { characters: targets.map(target => ({ name: target.characterName, avatar: target.characterAvatar })) };
    const runtime = { output: '<GM><Note>GM instruction</Note></GM><Tio>Tio instruction</Tio>' };
    const sandbox = { config: { agents: [agent] }, SillyTavern: { getContext: () => ctx },
        AGENT_OWNER_TYPES: { CHARACTER: 'character' },
        findCharacterConnection: () => ctx.characters[1],
        resolveCharacterByName: name => ({ character: ctx.characters.find(character => character.name === name) }),
        getAgentRuntimeState: () => runtime };
    sandbox.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    sandbox.renderAgentInjectionCharacterOptions = () => '<option>Character</option>';
    vm.createContext(sandbox);
    for (const name of ['normalizeOutputTagName', 'isValidXmlTagName', 'normalizeCharacterInjectionTargets',
        'getAgentInjectionTargets', 'resolveAgentInjectionTarget', 'isEmptyAgentInjectionContent',
        'tokenizeXmlOutput', 'parseXmlOutput', 'getOutputFormatContract', 'validateTaggedOutputFormat',
        'extractTaggedOutputSection', 'validateAgentOutput', 'buildAgentCharacterInjection', 'renderAgentInjectionTargets']) {
        const body = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
        assert(body, name);
        vm.runInContext(body, sandbox);
    }
    return { sandbox, agent, runtime, ctx };
}

test('optional destinations are skipped independently while present blocks reach their characters', () => {
    const { sandbox, agent, runtime } = fixture();
    assert.equal(sandbox.validateAgentOutput(agent, runtime.output).valid, true);
    const absent = sandbox.buildAgentCharacterInjection('Mirella');
    assert.equal(absent.errors.length, 0);
    assert.equal(absent.deliveries.length, 0);
    const gm = sandbox.buildAgentCharacterInjection('GM');
    assert.equal(gm.errors.length, 0);
    assert.equal(gm.deliveries[0].content, '<GM><Note>GM instruction</Note></GM>');
    assert.equal(sandbox.buildAgentCharacterInjection('Tio').deliveries[0].content, '<Tio>Tio instruction</Tio>');
    runtime.output = '<GM><Note>Updated</Note></GM>';
    assert.equal(sandbox.buildAgentCharacterInjection('Tio').deliveries.length, 0);
});

test('required destinations still reject a missing block and legacy targets default to required', () => {
    const { sandbox, agent, runtime } = fixture();
    agent.characterInjectionTargets[1].optional = false;
    assert.equal(sandbox.validateAgentOutput(agent, runtime.output).valid, false);
    const normalized = sandbox.normalizeCharacterInjectionTargets([{ characterName: 'GM', tag: '<GM>' }]);
    assert.equal(normalized[0].optional, false);
    const restored = sandbox.normalizeCharacterInjectionTargets(JSON.parse(JSON.stringify(agent.characterInjectionTargets)));
    assert.equal(restored[2].optional, true);
});

test('OUTPUT FORMAT permits an omitted optional subtree but still validates present nested structure', () => {
    const { sandbox, agent, runtime } = fixture();
    agent.validateOutputFormat = true;
    assert.equal(sandbox.validateAgentOutput(agent, runtime.output).valid, true);
    assert.equal(sandbox.validateAgentOutput(agent, '<GM></GM>').valid, false, 'Required nested Note is still missing');
    assert.equal(sandbox.validateAgentOutput(agent, '<GM><Note>Text</Note></GM><Mirella></Mirella>').valid, false);
    assert.equal(sandbox.validateAgentOutput(agent, '<GM><Note>Text</Note></GM><Mirella><Note>Text</Note></Mirella>').valid, true);
});

test('optional blocks still reject malformed tags, duplicate blocks and invalid configured tag names', () => {
    const { sandbox, agent, runtime } = fixture();
    for (const bad of ['<Mirella>Unclosed', '</Mirella>', '<Mirella>A</Mirella><Mirella>B</Mirella>']) {
        assert.equal(sandbox.validateAgentOutput(agent, runtime.output + bad).valid, false, bad);
    }
    agent.characterInjectionTargets[1].tag = '';
    assert.equal(sandbox.validateAgentOutput(agent, runtime.output).valid, false);
});

test('an optional destination cannot make another destination with the same required tag optional', () => {
    const { sandbox, agent } = fixture();
    agent.validateOutputFormat = true;
    agent.characterInjectionTargets[1].tag = 'GM';
    assert.equal(sandbox.validateAgentOutput(agent, '<Tio>Text</Tio>').valid, false);
});

test('character-owned targets preserve the optional setting and full output stays unchanged', () => {
    const { sandbox, agent, runtime } = fixture();
    agent.ownerType = 'character';
    assert.equal(sandbox.getAgentInjectionTargets(agent)[0].optional, true);
    assert.equal(sandbox.buildAgentCharacterInjection('Mirella').deliveries.length, 0);
    agent.characterInjectionTargets[1].mode = 'full';
    assert.equal(sandbox.buildAgentCharacterInjection('Mirella').deliveries[0].content, runtime.output);
});

test('destination controls show persisted optional flags and disable the option for full output', () => {
    const { sandbox, agent } = fixture();
    agent.characterInjectionTargets[2].mode = 'full';
    const html = sandbox.renderAgentInjectionTargets(agent);
    assert.match(html, /data-agent-injection-optional  >/);
    assert.match(html, /data-agent-injection-optional checked >/);
    assert.match(html, /data-agent-injection-optional checked disabled>/);
    assert.equal((html.match(/Optional block/g) ?? []).length, 3);
});
