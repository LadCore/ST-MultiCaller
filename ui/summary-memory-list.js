import { MEMORY_COLUMNS, mountMemoryResultsTable, renderMemoryRows, sortMemoryRows } from './memory-results-table.js';
export { getMemoryWindow } from './memory-results-table.js';

/** Filter display data without discarding memories used by rating and injection. */
export function selectSummaryMemories(summary, filter = 'inside', search = '') {
    const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
    const query = normalize(search).trim();
    return (summary?.allMemories ?? summary?.memories ?? []).filter(memory => filter === 'all'
        || (memory.loaded !== false && (filter === 'side' ? memory.side === true
            : filter === 'inside' ? memory.included === true : !memory.included && !memory.side)))
        .filter(memory => !query || normalize(`${memory.text ?? ''}\n${memory.id ?? ''}`).includes(query));
}

/** Static rendering uses the same rows as the virtualized live table. */
export function renderSummaryMemoryList(summary, escapeHtml, filter = 'inside') {
    const rows = sortMemoryRows(selectSummaryMemories(summary, filter).map(memory => ({ memory })),
        { column: 'box', direction: 'asc' });
    return rows.length ? renderMemoryRows(rows, MEMORY_COLUMNS, escapeHtml)
        : '<div class="sd-summary-status">No memories loaded.</div>';
}

/** In/Side/Out tabs share a sortable virtual table; changing tabs never calls the memory backend. */
export function mountSummaryMemoryList(root, summary, escapeHtml, onRender = () => {}) {
    if (!root) return () => {};
    const tabs = [['inside', 'In'], ['side', 'Side'], ['outside', 'Out'], ['all', 'All']];
    root.innerHTML = `<div class="sd-section-tabs sd-memory-filter-tabs" role="tablist" aria-label="Memory boxes">
        ${tabs.map(([key, label]) => `<button type="button" class="sd-section-tab" id="sd-memory-tab-${key}" role="tab" data-memory-filter="${key}" aria-controls="sd-memory-panel">${label} <span>${selectSummaryMemories(summary, key).length}</span></button>`).join('')}
        </div><div data-memory-search-controls>
            <label><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search In memories
                <input type="search" class="text_pole" data-memory-search placeholder="Text or memory ID" autocomplete="off">
            </label><div class="sd-summary-status" data-memory-search-count role="status" aria-live="polite"></div>
        </div><div id="sd-memory-panel" role="tabpanel" data-memory-table-panel></div>`;
    const panel = root.querySelector('[data-memory-table-panel]');
    const table = mountMemoryResultsTable(panel, { rows: [], escapeHtml, onRender,
        sort: { column: 'box', direction: 'asc' } });
    let active = 'inside';
    const searchInput = root.querySelector('[data-memory-search]');
    function updateRows() {
        const memories = selectSummaryMemories(summary, active, active === 'inside' ? searchInput.value : '');
        root.querySelector('[data-memory-search-count]').textContent = `${memories.length} / ${selectSummaryMemories(summary, active).length} memories`;
        table.setRows(memories.map(memory => ({ memory })));
    }
    function select(filter) {
        active = filter;
        root.querySelectorAll('[data-memory-filter]').forEach(button => {
            const selected = button.dataset.memoryFilter === filter;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        panel.setAttribute('aria-labelledby', `sd-memory-tab-${filter}`);
        root.querySelector('[data-memory-search-controls]').hidden = filter !== 'inside';
        updateRows();
    }
    const click = event => {
        const button = event.target.closest('[data-memory-filter]');
        if (button) select(button.dataset.memoryFilter);
    };
    const keydown = event => {
        if (!event.target.matches('[data-memory-filter]')) return;
        const index = tabs.findIndex(([key]) => key === active);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        select(tabs[next][0]);
        root.querySelector(`[data-memory-filter="${active}"]`).focus();
    };
    root.addEventListener('click', click);
    root.addEventListener('keydown', keydown);
    searchInput.addEventListener('input', updateRows);
    select('inside');
    return () => {
        table.destroy();
        root.removeEventListener('click', click);
        root.removeEventListener('keydown', keydown);
        searchInput.removeEventListener('input', updateRows);
    };
}
