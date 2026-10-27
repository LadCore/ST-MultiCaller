import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSummaryRating, evaluateSummaryMemories, normalizeSummaryHalfLives } from '../memory/summary-rating.js';
import { buildSummaryInjection, getCharacterSummary, saveCharacterSummary } from '../memory/character-summary.js';

const memory = (importance, index = 1) => ({ id: 'memory', text: 'Only the N2 text.', importance, last_relevant_message_index: index });

test('default half-lives and formula halve the score at the configured distance', () => {
    const halfLives = normalizeSummaryHalfLives();
    assert.deepEqual(halfLives, { 1: 100, 2: 200, 3: 400, 4: 800, 5: 1600 });
    for (let importance = 1; importance <= 5; importance++) {
        assert.equal(calculateSummaryRating(memory(importance), 1, halfLives).rating, importance / 5);
        assert.equal(calculateSummaryRating(memory(importance), 1 + halfLives[importance], halfLives).rating, importance / 10);
    }
    assert.equal(calculateSummaryRating(memory(0), 1, halfLives).rating, 0);
});

test('unknown importance and missing/future positions never get fabricated ratings', () => {
    for (const candidate of [memory(null), memory(2.5), memory(6), memory(1, null), memory(1, 50)]) {
        const result = calculateSummaryRating(candidate, 10, normalizeSummaryHalfLives());
        assert.equal(result.rating, null);
        assert(result.ratingError);
    }
});

test('cutoff follows calculated ratings rather than obsolete backend ratings', () => {
    const result = evaluateSummaryMemories([
        { ...memory(1), id: 'weak', rating: 1 }, { ...memory(5), id: 'strong', rating: 0.001 },
    ], 1, { minRating: 0.5 });
    assert.deepEqual(result.memories.map(item => item.id), ['strong']);
    assert.equal(result.allMemories.length, 2);
    assert.equal(result.text, 'Only the N2 text.');
});

test('changing chat length, cutoff and individual half-lives recalculates cached data without API writes', () => {
    const character = { name: 'Mirella', avatar: 'mirella.png', summary: {
        namespace: 'rp', groupId: 'mirella', minRating: 0.15, enabled: true,
    } };
    const ctx = { chatMetadata: {}, chat: Array(1) };
    const result = evaluateSummaryMemories([memory(1)], 1, character.summary);
    saveCharacterSummary(ctx, character, result);
    assert.equal(buildSummaryInjection(ctx, character).prompt, '<Summary>\nOnly the N2 text.\n</Summary>');
    ctx.chat.length = 101;
    assert.equal(getCharacterSummary(ctx, character).memories.length, 0);
    assert.equal(buildSummaryInjection(ctx, character), null);
    character.summary.halfLives = { 1: 1000 };
    assert.equal(getCharacterSummary(ctx, character).memories.length, 1);
    character.summary.minRating = 0.5;
    assert.equal(getCharacterSummary(ctx, character).memories.length, 0);
    assert.equal(ctx.chatMetadata.sceneDirector.characterSummaries['mirella.png'].allMemories[0].importance, 1);
});
