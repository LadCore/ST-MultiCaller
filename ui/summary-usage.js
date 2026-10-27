import { getCharacterSummary, summarySourceKey } from '../memory/character-summary.js';
import { checkSummaryMemoryUsage } from '../memory/summary-usage.js';
import { refreshReadOnlyTokenCounters, scheduleTokenCounterUpdate } from './token-counters.js';

/** Keep test snapshots and results in browser memory only, separately from persisted summaries. */
export function createSummaryUsagePanel({ getContext, getOwner, escapeHtml, checkUsage = checkSummaryMemoryUsage }) {
    const states = new WeakMap();
    const stateMap = metadata => {
        if (!states.has(metadata)) states.set(metadata, new Map());
        return states.get(metadata);
    };
    const percentage = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';

    function render(owner) {
        const state = stateMap(getContext().chatMetadata).get(owner.key);
        const rows = state?.rows ?? [];
        return `<div class="sd-summary-usage-heading"><b>Usage test</b><button type="button" class="menu_button" ${state?.running ? 'data-summary-usage-stop' : 'data-summary-usage-run'}><i class="fa-solid fa-${state?.running ? 'stop' : 'flask'}" aria-hidden="true"></i> ${state?.running ? 'Stop' : 'Compare text'}</button></div>
            <div data-token-count-container><label for="summary-usage-text">Text to compare</label><textarea id="summary-usage-text" data-summary-usage-text data-token-count-source class="text_pole" rows="6" spellcheck="false" ${state?.running ? 'readonly' : ''}>${escapeHtml(state?.draft ?? '')}</textarea><div class="sd-editor-meta"><span></span><span id="summary-usage-text-tokens" data-token-count-result>0 tokens</span></div></div>
            <div class="sd-summary-status" role="status">${escapeHtml(state?.total != null ? state.error || `${rows.length}/${state.total} memories · ${state.running ? 'Running' : 'Finished'} · Ratings unchanged` : 'Not run')}</div>
            ${rows.length ? `<div class="sd-summary-usage-table"><table><thead><tr><th>Memory / N2</th><th>Rating</th><th>Verdict</th><th>P(used)</th><th>Confidence</th></tr></thead><tbody>${rows.map(row => `<tr><td><details data-token-count-container open><summary>${escapeHtml(row.memory.id)} · <span data-token-count-result>...</span></summary><pre data-token-count-source>${escapeHtml(row.memory.text)}</pre></details>${row.result ? `<small>${escapeHtml(row.result.model ?? '')}</small>` : ''}${row.result?.warnings?.length ? `<div>${escapeHtml(row.result.warnings.join(' | '))}</div>` : ''}</td><td>${escapeHtml(row.memory.rating)}</td><td>${escapeHtml(row.error || row.result.verdict)}</td><td>${percentage(row.result?.usage_probability)}</td><td>${percentage(row.result?.confidence)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    }

    function notify(metadata, ownerKey) {
        if (getContext().chatMetadata !== metadata || getOwner().key !== ownerKey) return;
        const root = document.querySelector('[data-summary-usage]');
        if (!root) return;
        root.innerHTML = render(getOwner());
        refreshReadOnlyTokenCounters(root, text => getContext().getTokenCountAsync(text));
    }

    async function run() {
        const ctx = getContext();
        const owner = getOwner();
        if (!owner.character) return;
        const map = stateMap(ctx.chatMetadata);
        if (map.get(owner.key)?.running) return;
        const summary = getCharacterSummary(ctx, owner.character);
        const draft = map.get(owner.key)?.draft ?? '';
        const messages = [{ role: 'assistant', name: owner.character.name, content: draft }];
        const state = { draft, rows: [], total: summary?.memories.length ?? 0, running: false, error: '' };
        map.set(owner.key, state);
        if (!summary?.memories.length || summary.needsRefresh || summary.sourceKey !== summarySourceKey(owner.character)) {
            state.error = 'Update the summary before testing.';
        } else if (!draft.trim()) {
            state.error = 'Enter text to compare.';
        }
        if (state.error) { notify(ctx.chatMetadata, owner.key); return; }
        const controller = new AbortController();
        state.controller = controller;
        state.running = true;
        notify(ctx.chatMetadata, owner.key);
        try {
            for (const memory of summary.memories) {
                if (controller.signal.aborted || getContext().chatMetadata !== ctx.chatMetadata) break;
                try {
                    const result = await checkUsage(memory.text, messages, { signal: controller.signal });
                    state.rows.push({ memory, result });
                } catch (error) {
                    if (controller.signal.aborted) break;
                    state.rows.push({ memory, error: error.message });
                }
                notify(ctx.chatMetadata, owner.key);
            }
        } finally {
            state.running = false;
            if (controller.signal.aborted) state.error = 'Test stopped. Ratings unchanged.';
            else if (getContext().chatMetadata !== ctx.chatMetadata) state.error = 'Chat changed. Test stopped.';
            notify(ctx.chatMetadata, owner.key);
        }
    }

    function stop() {
        stateMap(getContext().chatMetadata).get(getOwner().key)?.controller?.abort();
    }

    function updateDraft(text) {
        const ctx = getContext();
        const key = getOwner().key;
        const map = stateMap(ctx.chatMetadata);
        const state = map.get(key) ?? {};
        if (state.running) return;
        map.set(key, { draft: text });
        scheduleTokenCounterUpdate('summary-usage-text', 'summary-usage-text-tokens', value => ctx.getTokenCountAsync(value));
    }

    return { render, run, stop, updateDraft };
}
