# Stepped Thinking: prompts and adaptation

## Sources

- Default prompts: https://github.com/cierru/st-stepped-thinking/blob/master/settings/settings.js#L634-L665
- Community examples: https://github.com/cierru/st-stepped-thinking/wiki/Prompts-for-thinking

The descriptions below are paraphrases, not verbatim extractions. The ready-to-use prompts are original adaptations for Backstage, not official Stepped presets. Community examples demonstrate approaches; they do not establish which approach performs best.

## What the defaults request

- Thoughts: pause the RP and describe the character's current thoughts in 2-4 bullets, illustrated through first-person feelings and doubts.
- Plans: pause the RP and describe current plans in 2-4 numbered items.

## Community approaches

- Jarv: separate environment, thoughts, plan, mood, and clothing. Thoughts consider impaired cognition; planning considers feasibility and trade-offs.
- Nicholas: four initial thoughts, four developed thoughts, then an outline of the reply.
- Nitral: a compact combined output containing immediate thoughts, immediate intention, and optional long-term goals.
- Steel-skull: broad analysis of relationships, conflicts, emotional dynamics, environment, and decisions.

## Judgment for this RP

I would separate a subjective reaction from an immediate intention. The broad scene-analysis approach overlaps with the GM; outlining the final reply may make a character's response feel rehearsed. These are hypotheses to evaluate in the RP, not measured findings.

The following prompts use first-person fictional inner speech. This is generated character state, not access to a model's hidden reasoning.

## CharThink

Configure this agent inside the character block with Schedule = Before character turn.

```text
Write the character's private thoughts immediately before their next turn in the ongoing roleplay. This is not their spoken reply and not advice from a narrator.

PERSONALITY
{{characterPersonality}}

SCENARIO
{{characterScenario}}

PREVIOUS PRIVATE THOUGHTS
{{previousOutput}}

RECENT EVENTS AND DIALOGUE
{{recentChat}}

Stay inside this character's perspective. Write in first person, in Brazilian Portuguese, with their vocabulary, priorities, emotional habits, and limitations.

Respond to what actually changed in the latest exchange. Let prior feelings persist when appropriate, but revise thoughts that events have made obsolete. Do not paraphrase the previous output simply to preserve it.

Select 2-4 short thoughts that genuinely matter now. They may concern an interpretation, a desire, a reluctance, a private association, or something the character is unwilling to admit. They need not cover every category.

The character may be biased, mistaken, distracted, amused, attracted, resentful, or uncertain when the scene and personality support it. Do not manufacture conflict or turn every moment into a dramatic revelation.

Treat other people's motives as interpretations, not facts. Do not invent past events, read minds, or acquire knowledge merely because it appears elsewhere in the conversation.

Do not plan the plot, recommend the optimal response, prescribe gestures, write dialogue, or outline the next message. Ordinary and playful thoughts are as valid as serious ones. Do not force self-analysis or emotional eloquence on a character who would not think that way.

Keep the entire output under 180 words. Return only the following XML block, with short first-person bullets inside it.

OUTPUT FORMAT
<private_thoughts>
- ...
</private_thoughts>
```

If the character already has a memory/summary agent, explicitly include its output tag in the context above. This template does not automatically query RAG or include another agent's memory.

## CharIntent

Configure this agent in the same character block with Schedule = Before character turn. Replace `mirella:CharThink` below with the actual ID displayed by the Thinking agent. The reference creates the execution dependency; both agents must have the before-turn schedule enabled to update in this stage.

```text
Write the character's private immediate intention for their next turn in the ongoing roleplay. You are not the GM, a writing coach, or an optimizer of the story.

PERSONALITY
{{characterPersonality}}

RECENT EVENTS AND DIALOGUE
{{recentChat}}

CURRENT PRIVATE THOUGHTS
{{agent:mirella:CharThink}}

PREVIOUS INTENTION
{{previousOutput}}

Write in first person, in Brazilian Portuguese, using this character's natural voice.

From their current thoughts and the immediate situation, identify what they want from this interaction now. An intention may be practical, social, emotional, playful, selfish, hesitant, or deliberately evasive. It must belong to the character, not to an external story plan.

Write one brief paragraph, at most three sentences. State the immediate desire and, only if relevant, a tension or limit that complicates it: something they hesitate to say, refuse to concede, or want to conceal.

Do not choose a sequence of actions, prescribe body language, draft dialogue, guarantee an outcome, or control another character. Leave the responding character free to decide how to express this intention, change their mind, or act imperfectly.

Preserve an earlier intention only while it remains meaningful. Do not invent a new ambition just because another turn is beginning. Do not automatically prioritize cooperation, caution, or the user's satisfaction over this character's actual personality.

Keep the entire output under 90 words. Return only the following XML block.

OUTPUT FORMAT
<private_intent>
...
</private_intent>
```

## Delivery

- Enable output-format validation on both agents.
- Enable full-output injection into the owner if both private blocks should reach the character.
- Use the same intended placement for both blocks. Execution order is determined by the dependency; it does not establish an explicit ordering contract between separate injected prompts.
- During evaluation, inspect the actual character request in Logs to confirm both current blocks reached the model.
- Keep the main GM plan out of these prompts unless deliberately testing a different setup.

Backstage currently supplies the last persisted output through `previousOutput`. That is not the same as Stepped's configurable history of multiple thought generations.
