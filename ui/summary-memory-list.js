/** Rating labels stay outside each N2 source; only selected N2 text is sent to the model. */
export function renderSummaryMemoryList(summary, escapeHtml, filter = 'inside') {
    const memories = selectSummaryMemories(summary, filter);
    const position = memory => Number.isInteger(memory.last_relevant_message_index)
        && memory.last_relevant_message_index > 0 ? memory.last_relevant_message_index : Infinity;
    const renderGroup = included => {
        const entries = memories.filter(memory => (memory.included === true) === included)
            .sort((a, b) => position(a) - position(b));
        if (!entries.length) return '';
        return `<h4 class="sd-summary-group-heading sd-summary-group-heading--${included ? 'inside' : 'outside'}">${included ? 'In box' : 'Outside box'} (${entries.length})</h4>`
            + entries.map(memory => renderMemoryRow(memory, escapeHtml)).join('');
    };
    return renderGroup(true) + renderGroup(false) || '<div class="sd-summary-status">No memories loaded.</div>';
}

/** Render one escaped row independently of grouping and virtualization. */
function renderMemoryRow(memory, escapeHtml, rowIndex = '') {
    const included = memory.included === true;
    const rating = Number.isFinite(memory.rating) ? Number(memory.rating.toPrecision(6)).toString() : '-';
    const details = memory.ratingError || `Importance ${memory.importance ?? '-'} · Last index ${memory.last_relevant_message_index ?? '-'} · Age ${memory.age ?? '-'} · Half-life ${memory.halfLife ?? '-'} · Base ${memory.baseRating?.toPrecision(4) ?? '-'} · Boost ${memory.boostRating?.toPrecision(4) ?? '0'}${memory.boost ? ` @ ${memory.boost.message_index}` : ''}`;
    return `<article data-memory-row="${rowIndex}" class="sd-summary-memory sd-summary-memory--${included ? 'inside' : 'outside'}${memory.ratingError ? ' sd-summary-memory--invalid' : ''}" data-token-count-container>
        <header><b>Rating ${escapeHtml(rating)}</b><span>${included ? 'In box' : 'Outside box'} · <span data-token-count-result>...</span></span></header>
        <div class="sd-summary-status">${escapeHtml(details)}</div>
        <pre data-token-count-source>${escapeHtml(memory.text)}</pre>
    </article>`;
}

/** Filter display data without discarding memories used by rating and injection. */
export function selectSummaryMemories(summary, filter = 'inside') {
    return (summary?.allMemories ?? summary?.memories ?? []).filter(memory => filter === 'all'
        || (memory.included === true) === (filter === 'inside'));
}

/** Locate the visible variable-height rows with a small overscan on either side. */
export function getMemoryWindow(heights, scrollTop, viewportHeight, overscan = 600) {
    const offsets = [0];
    for (const height of heights) offsets.push(offsets.at(-1) + height);
    let start = 0;
    while (start < heights.length && offsets[start + 1] < scrollTop - overscan) start++;
    let end = start;
    while (end < heights.length && offsets[end] < scrollTop + viewportHeight + overscan) end++;
    return { start, end, before: offsets[start], after: offsets.at(-1) - offsets[end] };
}

/** Mount only the visible memory rows; release observers when the panel is rebuilt. */
export function mountSummaryMemoryList(root, summary, escapeHtml, onRender = () => {}) {
    if (!root) return () => {};
    root.innerHTML = `<div class="sd-summary-filters" role="group" aria-label="Memory filter">
        <button type="button" class="menu_button" data-memory-filter="inside">In box</button>
        <button type="button" class="menu_button" data-memory-filter="outside">Outside box</button>
        <button type="button" class="menu_button" data-memory-filter="all">All</button>
        <span class="sd-summary-status" data-memory-count></span></div>
        <div class="sd-summary-text" tabindex="0" aria-label="Memories" data-memory-viewport>
            <div data-memory-before aria-hidden="true"></div><div data-memory-rows></div>
            <div data-memory-after aria-hidden="true"></div></div>`;
    const viewport = root.querySelector('[data-memory-viewport]');
    const rows = root.querySelector('[data-memory-rows]');
    let entries = [], heights = [], filter = 'inside', frame = 0, range = '';
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
    const observer = new ResizeObserver(items => {
        let changed = false;
        for (const item of items) {
            const index = Number(item.target.dataset.memoryRow);
            const height = Math.ceil(item.target.getBoundingClientRect().height) + 6;
            if (height > 6 && heights[index] !== height) { heights[index] = height; changed = true; }
        }
        if (changed) schedule();
    });
    function render() {
        if (!root.isConnected || !viewport.clientHeight) return;
        const window = getMemoryWindow(heights, viewport.scrollTop, viewport.clientHeight);
        root.querySelector('[data-memory-before]').style.height = `${window.before}px`;
        root.querySelector('[data-memory-after]').style.height = `${window.after}px`;
        const nextRange = `${filter}:${window.start}:${window.end}`;
        if (nextRange === range) return;
        range = nextRange;
        observer.disconnect();
        rows.innerHTML = entries.length
            ? entries.slice(window.start, window.end)
                .map((memory, offset) => renderMemoryRow(memory, escapeHtml, window.start + offset)).join('')
            : '<div class="sd-summary-status">No memories in this filter.</div>';
        rows.querySelectorAll('[data-memory-row]').forEach(row => observer.observe(row));
        onRender();
    }
    function select(nextFilter) {
        filter = nextFilter;
        entries = selectSummaryMemories(summary, filter).slice().sort((a, b) => {
            if (a.included !== b.included) return a.included ? -1 : 1;
            return (a.last_relevant_message_index ?? Infinity) - (b.last_relevant_message_index ?? Infinity);
        });
        heights = entries.map(() => 300);
        viewport.scrollTop = 0;
        range = '';
        root.querySelector('[data-memory-count]').textContent = `${entries.length} memories`;
        root.querySelectorAll('[data-memory-filter]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.memoryFilter === filter));
        });
        render();
    }
    const click = event => {
        const button = event.target.closest('[data-memory-filter]');
        if (button) select(button.dataset.memoryFilter);
    };
    const viewportObserver = new ResizeObserver(schedule);
    viewportObserver.observe(viewport);
    root.addEventListener('click', click);
    viewport.addEventListener('scroll', schedule, { passive: true });
    select('inside');
    return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        viewportObserver.disconnect();
        root.removeEventListener('click', click);
        viewport.removeEventListener('scroll', schedule);
    };
}
