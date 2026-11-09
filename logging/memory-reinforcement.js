import { backstageLogger } from './logger.js';

/** Present search input, native scores and observed box changes above full diagnostic payloads. */
export function formatMemoryUsageSummary(run) {
    if (run.semanticPhase) {
        const lines = [`SideBox ${run.semanticPhase}: ${run.found} semantic memory candidates.`,
            `Side: ${run.sideCount ?? 0} | Matching IDs: ${run.sideMatches.size} | Boosted: ${run.boosted} | Discarded: ${run.discarded ?? 0}`];
        const request = run.requests.findLast(item => item.stage === 'search-request')?.request;
        if (request) lines.push('', `Sent to search:\n${request.query}`, `Minimum similarity: ${request.min_similarity ?? 'none'}`);
        const ids = new Set([...run.candidates.keys(), ...run.sideMatches.keys(), ...run.movements.keys()]);
        for (const id of ids) {
            const candidate = run.candidates.get(id), match = run.sideMatches.get(id);
            const outcome = match?.outcome;
            lines.push('', `Memory: ${id} | Native scores: ${(candidate?.matches ?? match?.matches ?? []).map(item => item.similarity).join(', ') || 'not returned'}`,
                String(run.memories.get(id) ?? match?.text ?? '').slice(0, 220),
                `Box: ${run.movements.get(id) ?? (match ? 'Awaiting boost outcome' : 'No SideBox transition')}`);
            if (outcome) lines.push(`${outcome.action}: ${outcome.error || outcome.reason || 'Boost saved'}`);
        }
        return lines.join('\n');
    }
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
                searched: false, found: 0, memories: new Map(), usage: new Map(), sideMatches: new Map(),
                candidates: new Map(), movements: new Map() };
            runs.set(event.runId, run);
        }
        run.events.push(snapshot);
        if (event.phase) run.semanticPhase = event.phase;
        if (event.phase === 'after' && event.context?.sideIds) run.sideCount = event.context.sideIds.length;
        for (const memory of event.context?.sideMemories ?? []) run.memories.set(memory.id, memory.text);
        if (event.stage === 'side-ready') {
            run.sideCount = event.sideCount;
            for (const id of event.inMemoryIds ?? []) {
                if (run.candidates.has(id)) run.movements.set(id, 'In -> In (already in box)');
            }
            for (const memory of event.memories ?? []) {
                run.memories.set(memory.id, memory.text);
                run.movements.set(memory.id, 'Out -> Side');
            }
        }
        if (event.stage === 'side-match') run.sideMatches.set(event.memoryId, snapshot);
        if (event.stage === 'side-discarded') {
            run.discarded = (run.discarded ?? 0) + 1;
            run.movements.set(event.memoryId, `Side -> Out (${event.reason || 'not returned after response'})`);
        }
        if (event.request) run.requests.push({ stage: event.stage, request: event.request });
        if (event.result?.model) run.model = event.result.model;
        if (event.stage === 'search-result') {
            run.total = event.candidates?.length ?? 0;
            run.found = event.found ?? run.total;
            run.searched = true;
            for (const candidate of event.candidates ?? []) {
                run.memories.set(candidate.id, candidate.text ?? candidate.n1);
                run.candidates.set(candidate.id, candidate);
            }
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
            const match = run.sideMatches.get(event.memoryId);
            if (match) match.outcome = snapshot;
            if (run.semanticPhase) run.movements.set(event.memoryId, event.toBox
                ? `${event.fromBox} -> ${event.toBox}` : 'Side cleared; final box not confirmed');
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
                'side-ready': 'SideBox ready', 'side-match': 'Response matched SideBox memory', 'side-discarded': 'SideBox memory discarded',
                'usage-result': 'Verification received', 'patch-request': 'Saving boost',
                'patch-confirmed': 'Boost saved', finish: `Finished: ${event.status}` }[event.stage] || event.stage;
            updateOperationLog(run.id, {
                detail: `${stage} | ${run.semanticPhase
                    ? `${run.found} semantic candidates | ${run.sideCount ?? 0} Side | ${run.sideMatches.size} matching IDs`
                    : `${run.total} candidates | ${run.checked}/${run.total} checked | ${run.pending.size} pending`} | ${run.boosted} boosted | ${run.failed} failed | character=${event.character} | message_index=${event.message_index}\n\n${formatMemoryUsageSummary(run)}`,
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
