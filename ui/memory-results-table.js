export const MEMORY_COLUMNS = [['memory', 'Memory / N2'], ['box', 'Box'], ['importance', 'Importance'],
    ['rating', 'Rating'], ['index', 'Chat index'], ['boost', 'Boost']];
export const SEMANTIC_COLUMNS = [['memory', 'Memory / N2'], ['box', 'Box'], ['rating', 'Rating'],
    ['returned', 'Search'], ['similarity', 'First fact score'], ['matches', 'Fact matches']];

/** Read display/sort values without conflating a fact score with a per-memory probability. */
function cellValue(row, column) {
    const memory = row.memory;
    switch (column) {
        case 'memory': return String(memory.text ?? '');
        case 'box': return memory.loaded === false ? 3 : memory.included ? 0 : memory.side ? 1 : 2;
        case 'importance': return memory.importance;
        case 'rating': return memory.rating;
        case 'index': return memory.last_relevant_message_index;
        case 'boost': return memory.boostRating ?? memory.boost?.value ?? 0;
        case 'returned': return row.returned ? 0 : 1;
        case 'similarity': return row.matches?.[0]?.similarity;
        case 'matches': return row.matches?.length ?? 0;
        default: return null;
    }
}

/** Sort copies, with missing values last in both directions and deterministic native-order ties. */
export function sortMemoryRows(rows, sort = { column: 'index', direction: 'asc' }) {
    const missing = value => value == null || (typeof value === 'number' && !Number.isFinite(value));
    return [...rows].sort((a, b) => {
        const left = cellValue(a, sort.column), right = cellValue(b, sort.column);
        if (missing(left) || missing(right)) return Number(missing(left)) - Number(missing(right));
        const result = typeof left === 'string' ? left.localeCompare(String(right)) : left - right;
        if (result === 0 && sort.column === 'box') {
            return (a.memory.last_relevant_message_index ?? Infinity) - (b.memory.last_relevant_message_index ?? Infinity);
        }
        return result * (sort.direction === 'desc' ? -1 : 1);
    });
}

/** Locate a variable-height window with overscan without mounting the full data set. */
export function getMemoryWindow(heights, scrollTop, viewportHeight, overscan = 400) {
    const offsets = [0];
    for (const height of heights) offsets.push(offsets.at(-1) + height);
    let start = 0;
    while (start < heights.length && offsets[start + 1] < scrollTop - overscan) start++;
    let end = start;
    while (end < heights.length && offsets[end] < scrollTop + viewportHeight + overscan) end++;
    return { start, end, before: offsets[start], after: offsets.at(-1) - offsets[end] };
}

/** Escape stored text and keep full memory/fact details collapsed until explicitly opened. */
export function renderMemoryRows(rows, columns, escapeHtml, { start = 0, expanded = new Set() } = {}) {
    const number = value => Number.isFinite(value) ? String(Number(value.toPrecision(6))) : '-';
    const boxNames = ['In', 'Side', 'Out', 'Not loaded'];
    return rows.map((row, index) => {
        const memory = row.memory;
        const box = cellValue(row, 'box');
        const tone = row.returned != null ? (row.returned ? 'returned' : 'not-returned')
            : memory.ratingError ? 'invalid' : ['in', 'side', 'out', 'unknown'][box];
        const preview = String(memory.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 130);
        return `<div role="row" aria-rowindex="${start + index + 2}" class="sd-memory-data-row sd-memory-tone--${tone}" data-memory-row="${start + index}">${columns.map(([column]) => {
            let content;
            if (column === 'memory') {
                content = `<details ${expanded.has(memory.id) ? 'open' : ''}><summary><span>${escapeHtml(preview)}</span><small>${escapeHtml(memory.id ?? '')} · <span data-token-count-result>...</span></small></summary><pre data-token-count-source>${escapeHtml(memory.text ?? '')}</pre>
                    ${memory.ratingError ? `<div class="sd-memory-rating-error">${escapeHtml(memory.ratingError)}</div>` : ''}
                    ${(row.matches ?? []).map(match => `<div class="sd-memory-fact">${escapeHtml(match.fact_id)} · ${number(match.similarity)}</div>`).join('')}
                    ${memory.boost ? `<small>Boost index: ${escapeHtml(memory.boost.message_index)}</small>` : ''}</details>`;
            } else if (column === 'box') content = boxNames[box];
            else if (column === 'returned') content = row.returned ? 'Returned' : 'Not returned';
            else content = number(cellValue(row, column));
            return `<div role="cell" class="sd-memory-cell" ${column === 'memory' ? 'data-token-count-container' : ''}>${content}</div>`;
        }).join('')}</div>`;
    }).join('');
}

/** Shared sortable virtual table: only visible rows create DOM nodes and token counters. */
export function mountMemoryResultsTable(root, { rows = [], columns = MEMORY_COLUMNS, escapeHtml,
    sort = { column: 'index', direction: 'asc' }, onRender = () => {}, onSort = () => {} }) {
    root.innerHTML = `<div class="sd-memory-table-scroll" tabindex="0" aria-label="Memory results">
        <div role="table" class="sd-memory-table" aria-label="Memory results" aria-colcount="${columns.length}" aria-rowcount="${rows.length + 1}">
            <div role="rowgroup" class="sd-memory-table-head"><div role="row" data-memory-headers></div></div>
            <div role="rowgroup"><div data-memory-before aria-hidden="true"></div><div data-memory-rows></div><div data-memory-after aria-hidden="true"></div></div>
        </div></div>`;
    const viewport = root.querySelector('.sd-memory-table-scroll');
    const table = root.querySelector('.sd-memory-table');
    table.style.setProperty('--sd-memory-columns', `minmax(250px, 3fr) repeat(${columns.length - 1}, minmax(85px, 1fr))`);
    const body = root.querySelector('[data-memory-rows]');
    const header = root.querySelector('[data-memory-headers]');
    const expanded = new Set();
    const measured = new Map();
    let entries = [], heights = [], range = '', frame = 0, activeSort = sort, disposed = false;
    const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
    const observer = new ResizeObserver(items => {
        let changed = false;
        for (const item of items) {
            const index = Number(item.target.dataset.memoryRow);
            const height = Math.ceil(item.target.getBoundingClientRect().height);
            if (entries[index] && height > 0 && heights[index] !== height) {
                measured.set(entries[index].memory.id, height);
                heights[index] = height;
                changed = true;
            }
        }
        if (changed) schedule();
    });

    function render() {
        if (disposed || !root.isConnected || !viewport.clientHeight) return;
        const window = getMemoryWindow(heights, Math.max(0, viewport.scrollTop - header.offsetHeight), viewport.clientHeight);
        root.querySelector('[data-memory-before]').style.height = `${window.before}px`;
        root.querySelector('[data-memory-after]').style.height = `${window.after}px`;
        const next = `${window.start}:${window.end}`;
        if (range === next) return;
        range = next;
        observer.disconnect();
        // Keep live disclosures mounted: a resize can precede their deferred toggle event.
        const existing = new Map([...body.querySelectorAll('[data-memory-row]')]
            .map(row => [Number(row.dataset.memoryRow), row]));
        for (const [index, row] of existing) {
            if (index < window.start || index >= window.end) {
                const entry = entries[index];
                if (entry) {
                    if (row.querySelector('details')?.open) expanded.add(entry.memory.id); else expanded.delete(entry.memory.id);
                }
                row.remove();
            }
        }
        let cursor = body.firstElementChild;
        for (let index = window.start; index < window.end; index++) {
            let row = existing.get(index);
            if (!row) {
                const template = document.createElement('template');
                template.innerHTML = renderMemoryRows([entries[index]], columns, escapeHtml, { start: index, expanded });
                row = template.content.firstElementChild;
            }
            if (row !== cursor) body.insertBefore(row, cursor);
            cursor = row.nextElementSibling;
        }
        if (!entries.length) body.innerHTML = '<div class="sd-summary-status">No memories in this view.</div>';
        body.querySelectorAll('[data-memory-row]').forEach(row => observer.observe(row));
        onRender();
    }

    function setRows(nextRows, nextSort = activeSort) {
        body.querySelectorAll('[data-memory-row]').forEach(row => {
            const entry = entries[Number(row.dataset.memoryRow)];
            if (!entry) return;
            if (row.querySelector('details')?.open) expanded.add(entry.memory.id); else expanded.delete(entry.memory.id);
        });
        observer.disconnect();
        body.replaceChildren();
        activeSort = nextSort;
        entries = sortMemoryRows(nextRows, activeSort);
        heights = entries.map(row => measured.get(row.memory.id) ?? 80);
        viewport.scrollTop = 0;
        range = '';
        table.setAttribute('aria-rowcount', String(entries.length + 1));
        header.innerHTML = columns.map(([column, label]) => `<div role="columnheader" aria-sort="${activeSort.column === column
            ? (activeSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-memory-sort="${column}" title="Sort by ${label}">${label}<i class="fa-solid fa-${activeSort.column === column
            ? (activeSort.direction === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort'}" aria-hidden="true"></i></button></div>`).join('');
        render();
    }
    const click = event => {
        const button = event.target.closest('[data-memory-sort]');
        if (!button) return;
        const column = button.dataset.memorySort;
        const direction = column === activeSort.column ? (activeSort.direction === 'asc' ? 'desc' : 'asc')
            : ['importance', 'rating', 'boost', 'similarity', 'matches'].includes(column) ? 'desc' : 'asc';
        setRows(entries, { column, direction });
        onSort(activeSort);
        header.querySelector(`[data-memory-sort="${column}"]`)?.focus();
    };
    const toggle = event => {
        const details = event.target;
        if (disposed || !body.contains(details)) return;
        const row = details.closest('[data-memory-row]');
        const entry = row && entries[Number(row.dataset.memoryRow)];
        if (!entry) return;
        if (details.open) expanded.add(entry.memory.id); else expanded.delete(entry.memory.id);
        onRender();
    };
    const viewportObserver = new ResizeObserver(schedule);
    viewportObserver.observe(viewport);
    root.addEventListener('click', click);
    root.addEventListener('toggle', toggle, true);
    viewport.addEventListener('scroll', schedule, { passive: true });
    setRows(rows);
    return {
        setRows,
        destroy() {
            disposed = true;
            cancelAnimationFrame(frame);
            observer.disconnect();
            viewportObserver.disconnect();
            root.removeEventListener('click', click);
            root.removeEventListener('toggle', toggle, true);
            viewport.removeEventListener('scroll', schedule);
        },
    };
}
