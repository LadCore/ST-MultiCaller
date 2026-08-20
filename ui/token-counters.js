const counterTimers = new WeakMap();
const counterVersions = new WeakMap();

function getSourceText(source) {
    if (source.dataset.tokenCountEmpty === 'true') return '';
    if ('value' in source) return String(source.value ?? '');
    return String(source.textContent ?? '');
}

function setCounterText(counter, text) {
    if (counter) counter.textContent = text;
}

function scheduleElementTokenCount(source, counter, getTokenCountAsync, delayMs = 180) {
    if (!source || !counter || typeof getTokenCountAsync !== 'function') return;

    const currentVersion = (counterVersions.get(counter) || 0) + 1;
    counterVersions.set(counter, currentVersion);

    const existingTimer = counterTimers.get(counter);
    if (existingTimer) window.clearTimeout(existingTimer);

    const value = getSourceText(source);
    if (!value.trim()) {
        setCounterText(counter, '0 tokens');
        return;
    }

    setCounterText(counter, '...');
    const timerId = window.setTimeout(async () => {
        if (counterVersions.get(counter) !== currentVersion) return;

        try {
            const tokens = await getTokenCountAsync(value);
            if (counterVersions.get(counter) !== currentVersion) return;
            setCounterText(counter, `${Number(tokens) || 0} tokens`);
        } catch {
            if (counterVersions.get(counter) !== currentVersion) return;
            setCounterText(counter, '? tokens');
        }
    }, delayMs);

    counterTimers.set(counter, timerId);
}

export function scheduleTokenCounterUpdate(sourceId, counterId, getTokenCountAsync) {
    if (!sourceId || !counterId) return;

    const source = document.getElementById(sourceId);
    const counter = document.getElementById(counterId);
    scheduleElementTokenCount(source, counter, getTokenCountAsync);
}

export function refreshReadOnlyTokenCounters(root, getTokenCountAsync) {
    if (!root) return;

    root.querySelectorAll('[data-token-count-container]').forEach(container => {
        const disclosure = container.closest('details');
        if (disclosure && !disclosure.open) return;

        const source = container.querySelector('[data-token-count-source]');
        const counter = container.querySelector('[data-token-count-result]');
        scheduleElementTokenCount(source, counter, getTokenCountAsync, 0);
    });
}
