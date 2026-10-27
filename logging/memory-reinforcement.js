import { backstageLogger } from './logger.js';

/** Put used verdicts and their acceptance/write outcomes above the full diagnostic payloads. */
export function formatMemoryUsageSummary(run) {
    const results = [...run.usage.values()];
    const used = results.filter(item => item.result?.verdict === 'used')
        .sort((left, right) => right.result.usage_probability - left.result.usage_probability);
    const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
    const header = run.searched
        ? `Search: ${run.found} memories found; ${run.total} selected for verification.`
        : 'Search: awaiting results.';
    const lines = [header, `Used: ${used.length} of ${results.length} verified memories.`];
    if (!used.length) lines.push('No used verdicts received.');
    for (const item of used) {
        const outcome = item.outcome;
        const status = outcome?.action === 'boosted' ? 'Boost saved'
            : outcome?.action === 'error' ? `Boost failed: ${outcome.error}`
            : outcome?.action === 'skipped' ? `No boost: ${outcome.reason}`
            : item.decision?.accepted ? 'Thresholds passed; awaiting boost outcome'
            : `Thresholds not met: ${(item.decision?.reasons ?? []).join('; ')}`;
        const text = String(run.memories.get(item.memoryId) ?? '').replace(/\s+/g, ' ').trim();
        lines.push('', `USED | P(used): ${percent(item.result.usage_probability)} | Confidence: ${percent(item.result.confidence)}`,
            `Memory: ${item.memoryId}${text ? ` | ${text.length > 220 ? `${text.slice(0, 220)}...` : text}` : ''}`, status);
    }
    return lines.join('\n');
}

/** Mirror exact diagnostic events to the console and the existing Operation History. */
export function createMemoryReinforcementLogger({
    appendOperationLog, updateOperationLog, completeOperationLog, isProgressEnabled = () => true,
}) {
    const runs = new Map();
    return event => {
        const snapshot = structuredClone(event);
        const scope = `MemoryBoost:${event.character}`;
        const visible = isProgressEnabled();
        const issue = event.level === 'error' || event.level === 'warn';
        if (visible || issue) {
            backstageLogger[event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info'](scope, event.stage, snapshot);
        }
        let run = runs.get(event.runId);
        if (!run) {
            run = { id: null, events: [], requests: [], updated: 0, startedAt: new Date(),
                pending: new Set(), total: 0, checked: 0, boosted: 0, failed: 0, timer: null,
                searched: false, found: 0, memories: new Map(), usage: new Map() };
            runs.set(event.runId, run);
        }
        run.events.push(snapshot);
        if (event.request) run.requests.push({ stage: event.stage, request: event.request });
        if (event.result?.model) run.model = event.result.model;
        if (event.stage === 'search-result') {
            run.total = event.candidates?.length ?? 0;
            run.found = event.found ?? run.total;
            run.searched = true;
            for (const candidate of event.candidates ?? []) run.memories.set(candidate.id, candidate.text);
        }
        if (event.stage === 'usage-request') run.pending.add(event.memoryId);
        if (event.stage === 'usage-result') {
            run.pending.delete(event.memoryId);
            run.checked++;
            run.usage.set(event.memoryId, { ...snapshot });
        }
        if (event.stage === 'candidate-complete' || event.stage === 'candidate-error') {
            const usage = run.usage.get(event.memoryId);
            if (usage) usage.outcome = snapshot;
        }
        if (event.stage === 'candidate-complete' && event.action === 'boosted') run.boosted++;
        if (event.stage === 'candidate-error') { run.pending.delete(event.memoryId); run.failed++; }
        const done = event.stage === 'finish' || event.stage === 'duplicate-skipped';
        const failed = event.status === 'error' || event.status === 'stopped';
        if (run.id === null && (visible || issue || failed)) {
            run.id = appendOperationLog({ kind: 'memory-boost',
                step: `Memory boost: ${event.character} @ ${event.message_index}`, status: 'running',
                context: JSON.stringify(run.events[0], null, 2), startedAt: run.startedAt });
        }
        const flush = () => {
            clearTimeout(run.timer);
            run.timer = null;
            if (run.id === null || (!isProgressEnabled() && !issue && !done)) return;
            run.updated = Date.now();
            const stage = { start: 'Preparing conversation interval', 'search-request': 'Searching memories',
                'search-result': 'Memory search complete', 'usage-request': 'Verifying memory use',
                'usage-result': 'Verification received', 'patch-request': 'Saving boost',
                'patch-confirmed': 'Boost saved', finish: `Finished: ${event.status}` }[event.stage] || event.stage;
            updateOperationLog(run.id, {
                detail: `${stage} | ${run.total} candidates | ${run.checked}/${run.total} checked | ${run.pending.size} pending | ${run.boosted} boosted | ${run.failed} failed | character=${event.character} | message_index=${event.message_index}\n\n${formatMemoryUsageSummary(run)}`,
                model: run.model || '-', request: JSON.stringify(run.requests, null, 2),
                response: JSON.stringify(run.events, null, 2),
                error: done && event.status === 'error' ? event.error || 'Memory reinforcement failed.' : '',
            });
        };
        clearTimeout(run.timer);
        run.timer = null;
        if (run.id !== null && (visible || issue || done)) {
            if (done || issue || Date.now() - run.updated >= 750) flush();
            else run.timer = setTimeout(flush, 750 - (Date.now() - run.updated));
        }
        if (done) {
            if (run.id !== null) completeOperationLog(run.id, event.status || 'success');
            runs.delete(event.runId);
        }
    };
}
