import {
    fetchCharacterSummary, getCharacterSummary, normalizeSummaryConfig,
    saveCharacterSummary, summarySourceKey,
} from '../memory/character-summary.js';
import { createSummaryUsagePanel } from './summary-usage.js';
import { mountSummaryMemoryList } from './summary-memory-list.js';
import { mountSectionTabs } from './section-tabs.js';

/** Own manual refresh state; rendering and persistence remain independent of the router lifecycle. */
export function createCharacterSummaryPanel({
    getContext, getOwner, saveConfig, refresh, reportError, escapeHtml, fetchSummary = fetchCharacterSummary,
    getReinforcementStatus = () => ({}), stopReinforcement = () => {},
    renderCreation = () => '', onTabSelected = () => {},
    refreshTokens = () => {},
}) {
    let disposeMemoryList = null;
    const dispose = () => { disposeMemoryList?.(); disposeMemoryList = null; };
    const usagePanel = createSummaryUsagePanel({ getContext, getOwner, escapeHtml });
    const requests = new WeakMap();
    const statuses = new WeakMap();
    const stateFor = metadata => {
        if (!statuses.has(metadata)) statuses.set(metadata, new Map());
        return statuses.get(metadata);
    };

    function render(owner) {
        if (!owner.character) return '<section class="sd-character-summary"><h3>MemoryBox</h3><p>Select a character.</p></section>';
        const character = owner.character;
        const settings = normalizeSummaryConfig(character.summary);
        const summary = getCharacterSummary(getContext(), character);
        const status = stateFor(getContext().chatMetadata).get(owner.key) ?? {};
        const current = !summary?.needsRefresh && summary?.sourceKey === summarySourceKey(character);
        const checked = settings.enabled ? 'checked' : '';
        const reinforcementStatus = getReinforcementStatus(character);
        return `<section class="sd-character-summary sd-memory-summary" aria-label="Character summary" data-token-count-container data-summary-message-index="${getContext().chat?.length ?? 0}">
            <div class="sd-summary-heading"><h3>MemoryBox</h3><button type="button" data-summary-refresh class="menu_button" ${status.loading ? 'disabled' : ''}><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> ${status.loading ? 'Loading...' : 'Update'}</button></div>
            <details class="sd-summary-settings" data-summary-expand="source"><summary>Source and injection</summary>
                <div class="sd-row">
                    <label>Namespace<input class="text_pole" data-summary-field="namespace" value="${escapeHtml(settings.namespace)}"></label>
                    <label>Group<input class="text_pole" data-summary-field="groupId" value="${escapeHtml(settings.groupId)}"></label>
                    <label>Minimum calculated rating (0-1)<input class="text_pole" data-summary-field="minRating" type="number" min="0" max="1" step="any" value="${settings.minRating}"></label>
                </div>
                <label class="sd-checkbox-row"><input type="checkbox" data-summary-field="enabled" ${checked}><span>Inject into ${escapeHtml(character.name)}</span></label>
                <div class="floating_prompt_radio_group">
                    ${[['before-main', 'Before Main Prompt / Story String'], ['after-main', 'After Main Prompt / Story String'], ['in-chat', 'In-chat @ Depth']].map(([value, label]) => `<label class="checkbox_label"><input type="radio" name="summary-position" data-summary-field="characterInjectionPosition" value="${value}" ${settings.characterInjectionPosition === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}
                    <div class="sd-summary-depth"><label>Depth<input class="text_pole" data-summary-field="characterInjectionDepth" type="number" min="0" max="9999" value="${settings.characterInjectionDepth}"></label>
                    <label>Role<select class="text_pole" data-summary-field="characterInjectionRole">${['System', 'User', 'Assistant'].map((role, index) => `<option value="${index}" ${settings.characterInjectionRole === index ? 'selected' : ''}>${role}</option>`).join('')}</select></label></div>
                </div>
            </details>
            <details class="sd-summary-settings" data-summary-expand="decay"><summary>Decay by importance</summary>
                <div class="sd-summary-decay-fields">${Object.entries(settings.halfLives).map(([importance, halfLife]) => `<label>Importance ${importance}<input class="text_pole" data-summary-field="halfLife:${importance}" type="number" min="1" step="1" value="${halfLife}"><span>Half-life (messages)</span></label>`).join('')}</div>
                <div class="sd-summary-status">
                    <p><code>base = (importance / 5) × 2^(-distância / meia-vida)</code><br><code>reforço = boost.value × 2^(-(índiceAtual - boost.message_index) / meia-vida)</code><br><code>rating = min(1, base + reforço)</code></p>
                    <p>A distância é a quantidade atual de mensagens do chat menos <code>last_relevant_message_index</code> (posição a partir de 1). A meia-vida é o valor configurado para a importância: a cada intervalo desses, o rating cai pela metade.</p>
                    <p>Exemplo: importância 4 começa em 0,8; após 800 mensagens, com meia-vida de 800, cai para 0,4. Entra no box quando o rating calculado é maior ou igual ao corte. Importância 0 resulta em 0; importância ou posição ausente/inválida, ou posição futura, exclui a memória do box. O rating antigo do banco não participa do cálculo.</p>
                </div>
            </details>
            <details class="sd-summary-settings" data-summary-expand="reinforcement"><summary>Automatic memory reinforcement</summary>
                <label class="sd-checkbox-row"><input type="checkbox" data-summary-field="reinforcement.enabled" ${settings.reinforcement.enabled ? 'checked' : ''}><span>Reinforce memories before ${escapeHtml(character.name)} replies</span></label>
                <div class="sd-row">
                    <label>Minimum P(used)<input class="text_pole" type="number" min="0" max="1" step="0.01" data-summary-field="reinforcement.minUsageProbability" value="${settings.reinforcement.minUsageProbability}"></label>
                    <label>Minimum confidence<input class="text_pole" type="number" min="0" max="1" step="0.01" data-summary-field="reinforcement.minConfidence" value="${settings.reinforcement.minConfidence}"></label>
                    <label>Maximum candidate memories<input class="text_pole" type="number" min="1" max="50" step="1" data-summary-field="reinforcement.candidateLimit" value="${settings.reinforcement.candidateLimit}"></label>
                </div>
                <p class="sd-summary-status"><code>alvo = corte + (1 - corte) × (importance / 5)</code><br>Exige used e os dois limites. O boost completa o alvo sem reduzir um reforço efetivo maior. Importância e origem não mudam.</p>
            </details>
            <section class="sd-card"><div class="sd-card-head"><h4 class="sd-card-title">Memories</h4></div><div class="sd-card-body">
            ${reinforcementStatus.pending ? `<div class="sd-summary-status">Memory reinforcement: ${reinforcementStatus.pending} pending <button type="button" class="menu_button" data-summary-reinforcement-stop><i class="fa-solid fa-stop" aria-hidden="true"></i> Stop</button></div>` : ''}
            ${reinforcementStatus.lastError ? `<div class="sd-summary-reinforcement-error" role="alert">${escapeHtml(reinforcementStatus.lastError)}</div>` : ''}
            <div class="sd-summary-status" role="status">${summary ? `${summary.memories.length}/${summary.allMemories?.length ?? summary.memories.length} memories in box · ` : ''}<span data-token-count-result>...</span> · Chat index ${getContext().chat?.length ?? 0} · ${escapeHtml(status.error || (summary ? `${new Date(summary.updatedAt).toLocaleString()}${current ? '' : ' · Source changed or incomplete cache; update required'}` : 'No summary loaded.'))}</div>
            <div>
                <pre id="character-summary-text" hidden data-token-count-source data-token-count-empty="${!summary?.text}">${escapeHtml(summary?.text || '')}</pre>
                <div data-summary-virtual-list></div>
            </div>
            </div></section>
            <section class="sd-card"><div class="sd-card-head"><h4 class="sd-card-title">Usage test</h4></div><div class="sd-card-body"><section data-summary-usage aria-label="Summary usage test">${usagePanel.render(owner)}</section></div></section>
            <section class="sd-card sd-summary-creation-tab"><div class="sd-card-head"><h4 class="sd-card-title">Creation</h4></div><div class="sd-card-body">${renderCreation(character)}</div></section>
        </section>`;
    }

    function saveField(element) {
        const owner = getOwner();
        if (!owner.character) return;
        if (element.type === 'radio' && !element.checked) return;
        const value = element.type === 'checkbox' ? element.checked : element.value;
        const field = element.dataset.summaryField;
        const settings = normalizeSummaryConfig(owner.character.summary);
        if (field.startsWith('reinforcement.')) {
            settings.reinforcement[field.split('.')[1]] = value;
            owner.character.summary = normalizeSummaryConfig(settings);
            stopReinforcement(owner.character);
        } else if (field.startsWith('halfLife:')) {
            if (!Number.isFinite(Number(value)) || Number(value) < 1) { element.value = settings.halfLives[field.split(':')[1]]; return; }
            settings.halfLives[field.split(':')[1]] = Number(value);
            owner.character.summary = settings;
        } else {
            owner.character.summary = normalizeSummaryConfig({ ...settings, [field]: value });
        }
        saveConfig();
        updateControls(element.closest('.sd-memory-summary'));
        if (field === 'minRating' || field.startsWith('halfLife:')) {
            stopReinforcement(owner.character);
            const open = [...element.closest('.sd-memory-summary').querySelectorAll('[data-summary-expand][open]')].map(item => item.dataset.summaryExpand);
            refresh();
            open.forEach(name => { const details = document.querySelector(`[data-summary-expand="${name}"]`); if (details) details.open = true; });
        }
    }

    function updateControls(root) {
        if (!root) return;
        const settings = normalizeSummaryConfig(getOwner().character?.summary);
        root.querySelectorAll('[data-summary-field^="characterInjection"]').forEach(element => {
            element.disabled = !settings.enabled || (element.type !== 'radio' && settings.characterInjectionPosition !== 'in-chat');
        });
    }

    async function load() {
        const ctx = getContext();
        const owner = getOwner();
        if (!owner.character) return;
        const metadata = ctx.chatMetadata;
        if (!requests.has(metadata)) requests.set(metadata, new Set());
        const pending = requests.get(metadata);
        if (pending.has(owner.key)) return;
        const snapshot = { ...owner.character, summary: normalizeSummaryConfig(owner.character.summary) };
        const sourceKey = summarySourceKey(snapshot);
        pending.add(owner.key);
        stateFor(metadata).set(owner.key, { loading: true });
        refresh();
        try {
            const result = await fetchSummary(snapshot, { currentMessageIndex: ctx.chat?.length ?? 0 });
            const current = getContext();
            if (current.chatMetadata !== metadata || current.chatId !== ctx.chatId || current.groupId !== ctx.groupId) {
                throw new Error('Chat changed during refresh. The result was discarded.');
            }
            if (summarySourceKey(owner.character) !== sourceKey) throw new Error('Summary source changed during refresh. Update again.');
            saveCharacterSummary(ctx, snapshot, result);
            stateFor(metadata).set(owner.key, {});
        } catch (error) {
            stateFor(metadata).set(owner.key, { error: error.message });
            reportError(`Summary: ${snapshot.name}`, error.message);
        } finally {
            pending.delete(owner.key);
            refresh();
        }
    }

    function refreshRatings() {
        const root = document.querySelector('.sd-memory-summary');
        if (!root || !root.getClientRects().length || root.contains(document.activeElement)) return;
        if (Number(root.dataset.summaryMessageIndex) !== (getContext().chat?.length ?? 0)) refresh();
    }

    return {
        render, saveField, load, updateControls, refreshRatings, dispose,
        initTabs() {
            const root = document.querySelector('.sd-memory-summary');
            if (root) mountSectionTabs(root, { key: `summary:${getOwner().key}`, defaultLabel: 'Memories',
                orientation: 'vertical', onSelect: label => {
                    if (label === 'Memories' && !disposeMemoryList) {
                        const owner = getOwner();
                        disposeMemoryList = mountSummaryMemoryList(root.querySelector('[data-summary-virtual-list]'),
                            getCharacterSummary(getContext(), owner.character), escapeHtml, refreshTokens);
                    }
                    onTabSelected(label);
                } });
        },
        stopReinforcement: () => { const owner = getOwner(); if (owner.character) stopReinforcement(owner.character); },
        runUsageTest: usagePanel.run, stopUsageTest: usagePanel.stop, updateUsageDraft: usagePanel.updateDraft,
    };
}
