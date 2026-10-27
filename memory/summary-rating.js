export const DEFAULT_SUMMARY_HALF_LIVES = Object.freeze({ 1: 100, 2: 200, 3: 400, 4: 800, 5: 1600 });

/** Half-lives are measured in full-chat messages, independently for each importance level. */
export function normalizeSummaryHalfLives(value = {}) {
    return Object.fromEntries(Object.entries(DEFAULT_SUMMARY_HALF_LIVES).map(([importance, fallback]) => {
        const requested = Number(value?.[importance]);
        return [importance, Number.isFinite(requested) && requested > 0 ? requested : fallback];
    }));
}

/** Source positions are one-based; invalid or future positions are reported, never invented. */
export function calculateSummaryRating(memory, currentIndex, halfLives) {
    const importance = memory.importance;
    const index = memory.last_relevant_message_index;
    if (!Number.isInteger(importance) || importance < 0 || importance > 5) {
        return { rating: null, ratingError: 'Missing or invalid importance (0–5).' };
    }
    if (!Number.isInteger(index) || index < 1 || index > currentIndex) {
        return { rating: null, ratingError: 'Missing, invalid or future message index.' };
    }
    const age = currentIndex - index;
    const halfLife = importance ? halfLives[importance] : null;
    const baseRating = importance ? (importance / 5) * 2 ** (-age / halfLife) : 0;
    const boost = memory.boost;
    if (boost != null && (typeof boost.value !== 'number' || !Number.isFinite(boost.value) || boost.value < 0
        || !Number.isInteger(boost.message_index) || boost.message_index < 1 || boost.message_index > currentIndex)) {
        return { age, halfLife, baseRating, boostRating: 0, rating: null, ratingError: 'Invalid or future boost.' };
    }
    const boostRating = boost && importance ? boost.value * 2 ** (-(currentIndex - boost.message_index) / halfLife) : 0;
    return { age, halfLife, baseRating, boostRating, rating: Math.min(1, baseRating + boostRating), ratingError: '' };
}

/** Derive display diagnostics and the text-only injection from the same current rating calculation. */
export function evaluateSummaryMemories(memories, currentIndex, settings) {
    const halfLives = normalizeSummaryHalfLives(settings.halfLives);
    const allMemories = memories.map(memory => {
        const calculated = calculateSummaryRating(memory, currentIndex, halfLives);
        return { ...memory, ...calculated, included: calculated.rating !== null && calculated.rating >= settings.minRating };
    }).sort((a, b) => (a.rating ?? Infinity) - (b.rating ?? Infinity));
    const selected = allMemories.filter(memory => memory.included);
    return { allMemories, memories: selected, text: selected.map(memory => memory.text).join('\n\n'), currentIndex };
}
