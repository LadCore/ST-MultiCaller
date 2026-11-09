import { calculateSummaryRating, normalizeSummaryHalfLives } from './summary-rating.js';

/** Preserve the native optional semantic cutoff without inventing a probability threshold. */
export function normalizeReinforcementConfig(value = {}) {
    return {
        enabled: value.enabled === true,
        minSimilarity: value.minSimilarity == null || value.minSimilarity === '' || !Number.isFinite(Number(value.minSimilarity))
            ? null : Math.min(1, Math.max(-1, Number(value.minSimilarity))),
        candidateLimit: Math.min(50, Math.max(1, Math.floor(Number(value.candidateLimit) || 25))),
    };
}

/** Replace only the decaying boost; source importance and source message position are immutable here. */
export function planMemoryBoost(memory, messageIndex, settings) {
    const calculated = calculateSummaryRating(memory, messageIndex, normalizeSummaryHalfLives(settings.halfLives));
    if (calculated.ratingError) return { apply: false, reason: calculated.ratingError, calculated };
    if (!Number.isFinite(settings.minRating) || settings.minRating < 0 || settings.minRating >= 1) {
        return { apply: false, reason: 'Boost requires a calculated cutoff in [0, 1).', calculated };
    }
    if (memory.importance === 0) return { apply: false, reason: 'Importance zero is not reinforced.', calculated };
    if (memory.boost?.message_index >= messageIndex) {
        return { apply: false, reason: 'This or a newer message already reinforced the memory.', calculated };
    }
    const target = settings.minRating + (1 - settings.minRating) * (memory.importance / 5);
    const value = Math.max(calculated.boostRating, target - calculated.baseRating, 0);
    if (calculated.rating >= target) return { apply: false, reason: 'Current rating already meets the target.', target, calculated };
    return { apply: true, target, calculated, boost: { value, message_index: messageIndex } };
}
