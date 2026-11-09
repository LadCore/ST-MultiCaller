import { getCharacterSummary, getSummaryScope, normalizeSummaryConfig, summarySourceKey } from '../memory/character-summary.js';
import { findSemanticCandidates, prepareSemanticQuery } from '../memory/memorybox-client.js';
import { refreshReadOnlyTokenCounters, scheduleTokenCounterUpdate } from './token-counters.js';
import { selectSummaryMemories } from './summary-memory-list.js';
import { SEMANTIC_COLUMNS, mountMemoryResultsTable } from './memory-results-table.js';

/** Preserve native fact matches without claiming that retrieval confirms use. */
export function buildSemanticTestRows(summary, candidates) {
    const remaining = new Map((summary.allMemories ?? []).map(memory => [memory.id, memory]));
    const rows = candidates.map(candidate => {
        const memory = remaining.get(candidate.id) ?? { id: candidate.id, text: candidate.n1, loaded: false };
        remaining.delete(candidate.id);
        return { memory, returned: true, matches: candidate.matches };
    });
    return [...rows, ...[...remaining.values()].map(memory => ({ memory, returned: false, matches: [] }))];
}

/** One read-only semantic request per test, with transient per-chat diagnostics. */
export function createSummaryUsagePanel({ getContext, getOwner, escapeHtml, findCandidates = findSemanticCandidates }) {
    const states = new WeakMap();
    let table;
    const stateMap = metadata => {
        if (!states.has(metadata)) states.set(metadata, new Map());
        return states.get(metadata);
    };
    const current = () => stateMap(getContext().chatMetadata).get(getOwner().key);
    const dispose = () => { table?.destroy(); table = null; };
    const visibleRows = state => {
        const ids = new Set(selectSummaryMemories({ allMemories: (state?.rows ?? []).map(row => row.memory) },
            state?.scope ?? 'all').map(memory => memory.id));
        return (state?.rows ?? []).filter(row => ids.has(row.memory.id));
    };

    function render(owner) {
        const state = stateMap(getContext().chatMetadata).get(owner.key);
        const settings = normalizeSummaryConfig(owner.character?.summary).reinforcement;
        const summary = owner.character ? getCharacterSummary(getContext(), owner.character) : null;
        const source = state?.rows ? { allMemories: state.rows.map(row => row.memory) } : summary;
        const scopes = [['all', 'All memories'], ['inside', 'In box'], ['side', 'Side box'], ['outside', 'Outside box']];
        const status = state?.error || (state?.running ? 'Searching...' : state?.rows
            ? `${state.rows.filter(row => row.returned).length} returned memories · ${visibleRows(state).length} displayed · Ratings unchanged`
            : 'Not run');
        return `<div class="sd-summary-usage-heading"><b>Semantic test</b><button type="button" class="menu_button" ${state?.running ? 'data-summary-usage-stop' : 'data-summary-usage-run'}><i class="fa-solid fa-${state?.running ? 'stop' : 'flask'}" aria-hidden="true"></i> ${state?.running ? 'Stop' : 'Search'}</button></div>
            <label>Display filter<select class="text_pole" data-summary-usage-scope ${state?.running ? 'disabled' : ''}>${scopes.map(([value, label]) => `<option value="${value}" ${(state?.scope ?? 'all') === value ? 'selected' : ''}>${label} (${selectSummaryMemories(source, value).length})</option>`).join('')}</select></label>
            <label>Minimum semantic similarity<input class="text_pole" type="number" min="-1" max="1" step="0.01" data-summary-field="reinforcement.minSimilarity" value="${settings.minSimilarity ?? ''}" ${state?.running ? 'disabled' : ''}></label>
            <div data-token-count-container><label for="summary-usage-text">Text to search</label><textarea id="summary-usage-text" data-summary-usage-text data-token-count-source class="text_pole" rows="3" spellcheck="false" ${state?.running ? 'readonly' : ''}>${escapeHtml(state?.draft ?? '')}</textarea><div class="sd-editor-meta"><span>Min similarity: ${escapeHtml(settings.minSimilarity ?? 'none')} · Fact limit: ${settings.candidateLimit}</span><span id="summary-usage-text-tokens" data-token-count-result>0 tokens</span></div></div>
            <div class="sd-summary-status" role="status">${escapeHtml(status)}</div><div data-summary-semantic-results></div>
            ${state?.request ? `<details data-token-count-container><summary>Request · <span data-token-count-result>...</span></summary><pre data-token-count-source>${escapeHtml(JSON.stringify(state.request, null, 2))}</pre></details>` : ''}`;
    }

    function mount() {
        dispose();
        const root = document.querySelector('[data-summary-semantic-results]'), state = current();
        if (!root || !state?.rows || root.closest('[hidden]')) return;
        table = mountMemoryResultsTable(root, { rows: visibleRows(state), columns: SEMANTIC_COLUMNS, escapeHtml,
            sort: state.sort ?? { column: 'returned', direction: 'asc' }, onSort: sort => { state.sort = sort; },
            onRender: () => refreshReadOnlyTokenCounters(root, text => getContext().getTokenCountAsync(text)) });
    }

    function notify(metadata, key) {
        if (getContext().chatMetadata !== metadata || getOwner().key !== key) return;
        const root = document.querySelector('[data-summary-usage]');
        if (!root) return;
        dispose();
        root.innerHTML = render(getOwner());
        mount();
        refreshReadOnlyTokenCounters(root, text => getContext().getTokenCountAsync(text));
    }

    async function run() {
        const ctx = getContext(), owner = getOwner();
        if (!owner.character) return;
        const map = stateMap(ctx.chatMetadata), previous = map.get(owner.key) ?? {};
        if (previous.running) return;
        const summary = getCharacterSummary(ctx, owner.character);
        const state = { draft: previous.draft ?? '', scope: previous.scope ?? 'all', sort: previous.sort, error: '' };
        const query = prepareSemanticQuery(state.draft);
        map.set(owner.key, state);
        if (!summary || summary.needsRefresh || summary.sourceKey !== summarySourceKey(owner.character)) {
            state.error = 'Update the summary before testing.';
        } else if (!query) state.error = 'Enter text to search outside *actions*.';
        if (state.error) { notify(ctx.chatMetadata, owner.key); return; }
        const settingsKey = JSON.stringify(normalizeSummaryConfig(owner.character.summary));
        const settings = normalizeSummaryConfig(owner.character.summary).reinforcement;
        const scope = getSummaryScope(owner.character), controller = new AbortController();
        state.controller = controller;
        state.running = true;
        state.request = { ...scope, query, limit: settings.candidateLimit,
            ...(settings.minSimilarity != null ? { min_similarity: settings.minSimilarity } : {}) };
        notify(ctx.chatMetadata, owner.key);
        try {
            const result = await findCandidates(scope, query, settings.candidateLimit,
                { signal: controller.signal, minSimilarity: settings.minSimilarity });
            if (controller.signal.aborted) throw new Error('Test stopped. Ratings unchanged.');
            if (getContext().chatMetadata !== ctx.chatMetadata) throw new Error('Chat changed. Results discarded.');
            if (JSON.stringify(normalizeSummaryConfig(owner.character.summary)) !== settingsKey) {
                throw new Error('Summary settings changed. Results discarded.');
            }
            state.rows = buildSemanticTestRows(summary, result.candidates);
        } catch (error) {
            state.error = controller.signal.aborted ? 'Test stopped. Ratings unchanged.' : error.message;
        } finally {
            state.running = false;
            notify(ctx.chatMetadata, owner.key);
        }
    }

    function stop() { current()?.controller?.abort(); }

    function updateDraft(text) {
        const ctx = getContext(), key = getOwner().key, map = stateMap(ctx.chatMetadata), state = map.get(key) ?? {};
        if (state.running) return;
        map.set(key, { draft: text, scope: state.scope ?? 'all', sort: state.sort });
        dispose();
        document.querySelector('[data-summary-semantic-results]')?.replaceChildren();
        scheduleTokenCounterUpdate('summary-usage-text', 'summary-usage-text-tokens', value => ctx.getTokenCountAsync(value));
    }

    function updateScope(value) {
        const ctx = getContext(), key = getOwner().key, map = stateMap(ctx.chatMetadata), state = map.get(key) ?? {};
        if (state.running) return;
        state.scope = ['inside', 'side', 'outside', 'all'].includes(value) ? value : 'all';
        map.set(key, state);
        notify(ctx.chatMetadata, key);
    }

    return { render, mount, dispose, run, stop, updateDraft, updateScope };
}
