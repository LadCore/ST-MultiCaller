import { calculateSummaryRating, normalizeSummaryHalfLives } from './summary-rating.js';

/** Thresholds are experimental acceptance controls, not calibrated probabilities of correctness. */
export function normalizeReinforcementConfig(value = {}) {
    const threshold = input => input != null && input !== '' && Number.isFinite(Number(input))
        ? Math.min(1, Math.max(0, Number(input))) : 0.8;
    return {
        enabled: value.enabled === true,
        minUsageProbability: threshold(value.minUsageProbability),
        minConfidence: threshold(value.minConfidence),
        candidateLimit: Math.min(50, Math.max(1, Math.floor(Number(value.candidateLimit) || 25))),
    };
}

export function decideMemoryUsage(result, settings) {
    const policy = normalizeReinforcementConfig(settings);
    const reasons = [];
    if (result.verdict !== 'used') reasons.push(`verdict=${result.verdict}`);
    if (!Number.isFinite(result.usage_probability) || result.usage_probability < policy.minUsageProbability) {
        reasons.push(`usage_probability=${result.usage_probability} below ${policy.minUsageProbability}`);
    }
    if (!Number.isFinite(result.confidence) || result.confidence < policy.minConfidence) {
        reasons.push(`confidence=${result.confidence} below ${policy.minConfidence}`);
    }
    return { accepted: !reasons.length, reasons };
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
