console.log('[Backstage] Loading...');

const EXTENSION_NAME = 'MultiCaller';
const EXTENSION_DISPLAY_NAME = 'Backstage';
const EXTENSION_LABEL = 'Backstage';
const ROUTER_LABEL = 'Turn Router';
const STORY_DIRECTOR_LABEL = 'Story Director';
const CURRENT_CONFIG_VERSION = 9;
const DEFAULT_WORLD_CONTEXT_CHARS = 0;

const DEFAULT_SCENE_DIRECTOR_PROMPT = `You are the RP Scene Director for a SillyTavern group roleplay.

You are invisible. You never write chat prose. You never narrate the scene.
Your job is to decide who should speak next and provide a private direction for that character's next turn.

Use the recent chat, active characters, last speaker, and world context to preserve continuity, pacing, tension, and character agency.

Rules:
- Do not reveal information the selected character could not know.
- Do not force the user character's actions, thoughts, emotions, or dialogue.
- Prefer the character with the strongest immediate reason to act.
- If the scene needs the user to act, return USER as nextSpeaker.
- If nextSpeaker is USER, direction must be empty or exactly "Wait for the player's input."; scenePressure may describe what is at stake, and avoid must tell NPCs what not to resolve.
- Never instruct, command, script, or imply the user's next action.
- If nextSpeaker is a character, direction should be a private playable instruction for that character only.
- Keep direction specific, short, and playable. Prefer one clear action path; use conditional branches only when uncertainty is the point of the turn.
- Write avoid as clear prohibitions. Prefer separate "Do not..." clauses and avoid ambiguous wording.
- Do not summarize all lore. Use only what matters now.
- Output valid JSON only. No markdown. No prose outside JSON.

Characters:
{{players}}

Last speaker:
{{lastSpeaker}}

Recent chat:
{{recentChat}}

World context:
{{worldContext}}

StoryGuide:
{{storyGuide}}

Return:
{
  "nextSpeaker": "name or USER",
  "reason": "brief internal reason",
  "direction": "private instruction for the next speaker's next turn",
  "scenePressure": "what should keep the scene moving",
  "avoid": "what the next speaker must not do"
}`;

const DEFAULT_STORY_PLANNER_PROMPT = `You are the private Story Planner for a long-form SillyTavern group RP.

You are invisible. You never write chat prose, narration, dialogue, or a reply for any character.
You do not choose the next speaker. You maintain a persistent StoryGuide used by the SceneDirector and GM.

Your job is to act like a disciplined manga/anime series planner:
- Keep the current arc moving toward a satisfying conclusion.
- Track major plot threads, hidden reveals, character risks, emotional pressure, and continuity.
- Build momentum for drama, death risk, betrayal risk, discoveries, reversals, and consequences without forcing the player character.
- Preserve uncertainty. Do not solve mysteries too early. Do not remove tension just because the party found temporary safety.

Inputs you will receive:
- Current StoryGuide: the existing private plan, or empty if no plan exists.
- Recent chat: the latest visible RP events.
- World context: active lore/RAG context, when available.
- Selected lorebook catalog: available lorebook entries from the books selected for planner scope.
- Last SceneDirector decision: the latest turn-level routing/direction, when available.

Mode A - no current StoryGuide:
If Current StoryGuide is empty, create a strong plan for the current arc from the available chat and world context.
The plan should cover the current arc from its present position to its likely conclusion.
Also include a lightweight long-range runway for later arcs so the current arc can seed future payoffs.
Infer only what is reasonably supported. Mark uncertain assumptions as "Candidate" instead of treating them as fact.

Mode B - existing StoryGuide:
If Current StoryGuide already exists, update it incrementally.
Preserve useful structure, established facts, unresolved threads, and future payoffs.
Advance completed beats, remove stale instructions, add new consequences, and revise the route when the RP changes direction.
When the current arc appears concluded, close it cleanly and draft the next arc plan. Keep a long-range runway toward the eventual RP endgame.

Output rules:
- Return only the updated StoryGuide in concise Markdown. No code fences. No commentary outside the plan.
- Be specific enough that the SceneDirector can create next-turn directions from it.
- Do not script the player's actions, thoughts, emotions, dialogue, or success/failure.
- Do not force NPC outcomes that should emerge in play. Express them as pressures, options, or conditional beats.
- Do not reveal hidden information to characters; this is private planning state.
- Prefer actionable planning over lore summary.

Required StoryGuide structure:
# Arc Header
- Arc: Arc X - short arc name
- Reference: #X Manga / #X lorebook, or Candidate if uncertain
- Current stage: setup / travel / investigation / confrontation / fallout / transition
- Current scene:
- Immediate objective:
- Arc end condition:
- Current pressure:

# Arc Route
- Where we are now:
- Next required beat:
- Mid-arc turn:
- Crisis / point of no return:
- Possible arc conclusions:
- Fallout into next arc:

# Pending Plots
- Active plot threads:
- Waiting for payoff:
- At risk of being forgotten:
- Ready to reveal soon:
- Should stay hidden:

# Unknown User Skills
- Unknown or partially known skills:
- Foreshadowing already planted:
- Next safe clue:
- Reveal conditions:
- Do not reveal yet:

# Character Secrets
- Leira hiding:
- Eve hiding:
- Lisbeth hiding:
- Ayaka hiding:
- Other NPC secrets:
- Betrayal risk:

# Goddess / World Facts
- Known by the party:
- Known only to the planner/GM:
- False beliefs currently in play:
- Facts that can pressure the current arc:
- Facts that must remain delayed:

# Scene Fuel
- Drama levers:
- Death or injury risk:
- Trust stress:
- Resource pressure:
- External threat clock:

# Beat Queue
- Next 1-3 turns:
- Next scene:
- Before arc conclusion:
- Seeds for later arcs:

# Continuity Locks
- Established facts:
- Do not contradict:
- Open questions:

# Director Guidance
- What the SceneDirector should prioritize:
- What the SceneDirector should avoid:
- When to call GM instead of a character:`;
const PLANNER_OOC_DEFAULT_DRAFT = `OOC

Planner pause the RP for a while`;
const ROUTER_OOC_DEFAULT_DRAFT = `OOC

Router pause the RP for a while`;

const DEFAULT_CONFIG = {
    configVersion:     CURRENT_CONFIG_VERSION,
    routerProfileId:   '',
    plannerProfileId:  '',
    contextMessages:   5,
    routerInputTokenBudget: 0,
    worldContextChars: DEFAULT_WORLD_CONTEXT_CHARS,
    plannerUserTurnInterval: 5,
    plannerWorldInfoBooks: [],
    routerTimedLorebookBook: '',
    routerTimedLorebookUid: '',
    routerTimedLorebookName: '',
    routerTimedLorebookTriggerRegex: '',
    enabled:           true,
    routerPrompt:      DEFAULT_SCENE_DIRECTOR_PROMPT,
    plannerPrompt:     DEFAULT_STORY_PLANNER_PROMPT,
    characters: [],
    // characters: [{ name, profileId, profileName }]
};

let config = { ...DEFAULT_CONFIG };
let isProcessing = false;
let lastActiveChar = null;
let isStoryGuideUpdateInProgress = false;
let sceneDirectorState = {
    panelOpen: false,
    activeTab: 'router',
    directorView: 'workspace',
    routerView: 'workspace',
    routerStatus: 'idle',
    routerUpdatedAt: null,
    directorStatus: 'idle',
    directorUpdatedAt: null,
    lastContext: null,
    lastDecision: null,
    lastReasoning: '',
    lastRawOutput: '',
    plannerReasoning: '',
    plannerRawOutput: '',
    plannerError: '',
    lastPromptMessages: null,
    lastPlannerPromptMessages: null,
    routerOocDraft: ROUTER_OOC_DEFAULT_DRAFT,
    routerOocHistory: [],
    plannerOocDraft: PLANNER_OOC_DEFAULT_DRAFT,
    plannerOocHistory: [],
    routerTimedLorebookSearch: '',
    persistentIssue: '',
    persistentIssueSource: '',
    persistentIssueAt: null,
    lastError: '',
};
let lastDirectorRequest = null;
let forcedRouterSpeaker = null;
let skipNextCharacterAutoRouter = false;
let pendingAutoRouter = false;

// ================= FLOW LOG =================

const T0 = Date.now();
function fl(direction, method, detail = '') {
    const t = ((Date.now() - T0) / 1000).toFixed(2);
    const det = detail ? ` | ${detail}` : '';
    console.log(`[Backstage][${t}s] ${direction} ${method}${det}`);
}

// ================= CONFIG =================

function saveConfig() {
    localStorage.setItem(`st_${EXTENSION_NAME}_settings`, JSON.stringify(config));
}

function isLegacyRouterPrompt(prompt) {
    return String(prompt ?? '').includes('ONE WORD ONLY') || !String(prompt ?? '').includes('{{worldContext}}');
}

function needsSceneDirectorPromptRefresh(prompt) {
    const value = String(prompt ?? '');
    return isLegacyRouterPrompt(value)
        || !value.includes('If nextSpeaker is USER')
        || !value.includes('Never instruct, command, script, or imply the user');
}

function needsStoryPlannerPromptRefresh(prompt) {
    const value = String(prompt ?? '');
    return !value
        || (value.includes('Required sections:')
            && value.includes('# Drama Policy')
            && !value.includes('Mode A - no current StoryGuide'))
        || (value.includes('# Story Position')
            && value.includes('# Long-Range Runway')
            && !value.includes('# Arc Header'));
}

function migrateConfig() {
    const previousVersion = Number(config.configVersion || 1);

    if (previousVersion < CURRENT_CONFIG_VERSION) {
        if (needsSceneDirectorPromptRefresh(config.routerPrompt)) {
            config.routerPrompt = DEFAULT_SCENE_DIRECTOR_PROMPT;
        }
        if (config.routerInputTokenBudget == null) {
            config.routerInputTokenBudget = 0;
        }
        config.routerInputTokenBudget = Math.max(0, parseInt(config.routerInputTokenBudget) || 0);
        if (config.worldContextChars == null) {
            config.worldContextChars = DEFAULT_WORLD_CONTEXT_CHARS;
        }
        if (config.plannerProfileId == null) {
            config.plannerProfileId = '';
        }
        if (config.plannerUserTurnInterval == null) {
            config.plannerUserTurnInterval = DEFAULT_CONFIG.plannerUserTurnInterval;
        }
        if (!Array.isArray(config.plannerWorldInfoBooks)) {
            config.plannerWorldInfoBooks = [];
        }
        if (config.routerTimedLorebookBook == null) {
            config.routerTimedLorebookBook = DEFAULT_CONFIG.routerTimedLorebookBook;
        }
        if (config.routerTimedLorebookUid == null) {
            config.routerTimedLorebookUid = DEFAULT_CONFIG.routerTimedLorebookUid;
        }
        if (config.routerTimedLorebookName == null) {
            config.routerTimedLorebookName = DEFAULT_CONFIG.routerTimedLorebookName;
        }
        if (config.routerTimedLorebookTriggerRegex == null) {
            config.routerTimedLorebookTriggerRegex = DEFAULT_CONFIG.routerTimedLorebookTriggerRegex;
        }
        if (needsStoryPlannerPromptRefresh(config.plannerPrompt)) {
            config.plannerPrompt = DEFAULT_STORY_PLANNER_PROMPT;
        }
        delete config.maxTokens;
        config.configVersion = CURRENT_CONFIG_VERSION;
        saveConfig();
    }
}

function loadConfig() {
    const saved = localStorage.getItem(`st_${EXTENSION_NAME}_settings`);
    if (saved) {
        config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    }
    migrateConfig();
}

const routerTimedLorebookEntryCache = new Map();
let routerTimedLorebookLastTriggerSignature = '';

// ================= SOUND =================

const USER_SOUND_URL = '/scripts/extensions/third-party/MultiCaller/sounds/User.mp3';

function playUserSound() {
    try {
        const audio = new Audio(USER_SOUND_URL);
        audio.volume = 0.5;
        audio.play().catch(() => {});
    } catch (_) {}
}

// ================= CHAT LOCK =================

function lockChat() {
    $('#send_textarea').prop('disabled', true);
    $('#send_but').prop('disabled', true);
}

function unlockChat() {
    $('#send_textarea').prop('disabled', false);
    $('#send_but').prop('disabled', false);
    $('#send_textarea').focus();
}

// ================= CHARACTER NOTE =================

const CHAR_NOTE_KEY = 'rp-router-char-note';
const SCENE_DIRECTION_KEY = 'scene-director-next-reply';
const LOREBOOK_INJECTION_KEY = 'scene-director-lorebook-context';
const STORY_GUIDE_INJECTION_KEY = 'scene-director-story-guide-context';
const DIRECT_OOC_KEY = 'scene-director-direct-ooc';
const EXTENSION_PROMPT_TYPES = {
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};
const EXTENSION_PROMPT_ROLES = {
    SYSTEM: 0,
};

function setCharacterNote(charName) {
    const ctx = SillyTavern.getContext();
    const note = `[Write the next reply only as ${charName}. Do NOT speak as any other character.]`;
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(CHAR_NOTE_KEY, note, EXTENSION_PROMPT_TYPES.BEFORE_PROMPT, 0);
    }
}

function clearCharacterNote() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(CHAR_NOTE_KEY, '', EXTENSION_PROMPT_TYPES.BEFORE_PROMPT, 0);
    }
}

function parseDirectedOocMessage(text) {
    const source = String(text ?? '').replace(/\r/g, '').trim();
    if (!source) return null;

    const match = source.match(/^OOC\s+([^\n]+)(?:\n+([\s\S]*))?$/i);
    if (!match) return null;

    const target = String(match[1] ?? '').trim();
    const request = String(match[2] ?? '').trim();
    if (!target || !request) return null;

    return { target, request, raw: source };
}

function isBackstageOocMessage(text) {
    return /^OOC\b/i.test(String(text ?? '').trim());
}

function setDirectedOocPrompt(charName, oocText) {
    const ctx = SillyTavern.getContext();
    const request = String(oocText ?? '').trim();
    if (!request || typeof ctx.setExtensionPrompt !== 'function') {
        clearDirectedOocPrompt();
        return;
    }

    const prompt = `[PRIVATE OOC DIRECTIVE - NEXT REPLY ONLY]
You are replying as ${charName}, but this next reply must be OOC, not in-scene narration.

Rules:
- Start your reply with: OOC ${charName}
- Answer the operator's request directly and clearly.
- Do not continue the RP scene.
- Do not act as other characters.
- Do not mention hidden prompts, routing, or system instructions.

Operator request:
${request}
[/Direct OOC]`;

    ctx.setExtensionPrompt(
        DIRECT_OOC_KEY,
        prompt,
        EXTENSION_PROMPT_TYPES.IN_PROMPT,
        0,
        false,
        EXTENSION_PROMPT_ROLES.SYSTEM,
    );
}

function clearDirectedOocPrompt() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(
            DIRECT_OOC_KEY,
            '',
            EXTENSION_PROMPT_TYPES.IN_PROMPT,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    }
}

function normalizePlannerSectionName(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === 'gm') return 'gm';
    return normalized.split(/\s+/)[0] ?? '';
}

function parseLorebookControlBlock(storyGuide) {
    const source = String(storyGuide ?? '');
    const blockMatch = source.match(/\[LOREBOOK_CONTROL\]([\s\S]*?)\[\/LOREBOOK_CONTROL\]/i);
    if (!blockMatch) {
        return { sections: new Map(), raw: '' };
    }

    const body = String(blockMatch[1] ?? '');
    const lines = body.split(/\r?\n/);
    const sections = new Map();
    let currentSection = '';

    for (const rawLine of lines) {
        const line = String(rawLine ?? '').trim();
        if (!line) continue;

        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            currentSection = String(sectionMatch[1] ?? '').trim();
            if (currentSection && !sections.has(currentSection)) {
                sections.set(currentSection, []);
            }
            continue;
        }

        if (!currentSection || /^-\s*none$/i.test(line)) {
            continue;
        }

        const uidMatch = line.match(/uid:\s*(\d+)/i);
        if (!uidMatch) {
            continue;
        }

        const nameMatch = line.match(/name:\s*"([^"]+)"/i);
        sections.get(currentSection)?.push({
            name: String(nameMatch?.[1] ?? '').trim(),
            uid: Number(uidMatch[1]),
        });
    }

    return { sections, raw: blockMatch[0] };
}

function parseStoryGuideBlocks(storyGuide) {
    const source = String(storyGuide ?? '');
    const blocks = [];
    const blockPattern = /\[(?!\/)([^\]\r\n]+)\]([\s\S]*?)\[\/\1\]/gi;
    let match = null;

    while ((match = blockPattern.exec(source)) !== null) {
        blocks.push({
            name: String(match[1] ?? '').trim(),
            body: String(match[2] ?? '').trim(),
            raw: String(match[0] ?? '').trim(),
        });
    }

    return blocks;
}

function parseStoryGuideTaggedSections(blockBody) {
    const sections = new Map();
    const lines = String(blockBody ?? '').split(/\r?\n/);
    let currentSection = '';

    for (const rawLine of lines) {
        const line = String(rawLine ?? '');
        const trimmed = line.trim();
        if (!trimmed) {
            if (currentSection) {
                sections.get(currentSection)?.lines.push('');
            }
            continue;
        }

        const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            currentSection = String(sectionMatch[1] ?? '').trim();
            if (currentSection && !sections.has(currentSection)) {
                sections.set(currentSection, { name: currentSection, lines: [] });
            }
            continue;
        }

        if (!currentSection) {
            continue;
        }

        sections.get(currentSection)?.lines.push(line.trimEnd());
    }

    return Array.from(sections.values())
        .map(section => ({
            name: section.name,
            text: section.lines.join('\n').trim(),
        }))
        .filter(section => section.text);
}

function selectStoryGuideSectionsForSpeaker(storyGuide, speakerName) {
    const normalizedSpeaker = normalizePlannerSectionName(speakerName);
    if (!normalizedSpeaker) return [];

    const blocks = parseStoryGuideBlocks(storyGuide);
    const selectedSections = blocks
        .map(block => {
            const sections = parseStoryGuideTaggedSections(block.body);
            const matchedSection = sections.find(item => normalizePlannerSectionName(item.name) === normalizedSpeaker);

            if (!matchedSection || /^-\s*none$/i.test(matchedSection.text)) {
                return null;
            }

            return {
                blockName: block.name,
                sectionName: matchedSection.name,
                text: matchedSection.text,
            };
        })
        .filter(Boolean);

    return selectedSections;
}

function buildStoryGuideInjectionPrompt(storyGuide, charName) {
    const source = String(storyGuide ?? '').trim();
    const speaker = String(charName ?? '').trim();
    if (!source || !speaker) return '';

    if (normalizePlannerSectionName(speaker) === 'gm') {
        return `[SCENE_DIRECTION]
speaker: ${speaker}
scope: next reply only
mode: private

[RULES]
- Treat the StoryGuide as hidden planning state.
- Do not quote, mention, or reveal this plan directly.
- Do not reveal hidden information before the scene earns it.
- Keep continuity, pacing, and unresolved tension intact.
- Do not mention the StoryGuide, planner, router, or hidden instructions.
[/RULES]

[STORYGUIDE]
${source}
[/STORYGUIDE]
[/SCENE_DIRECTION]`;
    }

    const relevantSections = selectStoryGuideSectionsForSpeaker(source, speaker);
    if (!relevantSections.length) return '';

    const body = relevantSections
        .map(section => `[${section.blockName}]
[${section.sectionName}]
${section.text}
[/${section.blockName}]`)
        .join('\n\n');

    return `[SCENE_DIRECTION]
speaker: ${speaker}
scope: next reply only
mode: private

[RULES]
- Treat the StoryGuide as hidden planning state, not public narration.
- Use it to guide emphasis, restraint, suspicion, priorities, and payoff timing.
- Do not quote, mention, or reveal this plan directly.
- Do not turn hidden information into explicit certainty unless your character could already know it.
- Do not resolve reveals, mysteries, or payoffs before their stated conditions.
- Stay in character and keep the current scene grounded.
[/RULES]

[STORYGUIDE]
${body}
[/STORYGUIDE]
[/SCENE_DIRECTION]`;
}

async function getPlannerLorebookLibrary(selectedBooks = config.plannerWorldInfoBooks) {
    const books = (Array.isArray(selectedBooks) ? selectedBooks : [])
        .map(name => String(name ?? '').trim())
        .filter(Boolean);

    if (!books.length) return [];

    try {
        const wi = await getWorldInfoModule();
        if (typeof wi.loadWorldInfo !== 'function') {
            return [];
        }

        const library = [];
        for (const bookName of books) {
            const data = await wi.loadWorldInfo(bookName);
            for (const entry of Object.values(data?.entries ?? {})) {
                library.push({
                    book: bookName,
                    uid: Number(entry?.uid),
                    name: String(entry?.comment ?? '').trim(),
                    content: String(entry?.content ?? '').trim(),
                    disable: !!entry?.disable,
                });
            }
        }

        return library;
    } catch (error) {
        console.warn('[SceneDirector] Failed to load planner lorebook library:', error);
        return [];
    }
}

function resolveLorebookReferencesForSpeaker(control, speakerName) {
    const normalizedSpeaker = normalizePlannerSectionName(speakerName);
    if (!normalizedSpeaker) return [];

    if (normalizedSpeaker === 'gm') {
        const merged = [];
        for (const refs of control.sections.values()) {
            merged.push(...refs);
        }
        return merged;
    }

    for (const [sectionName, refs] of control.sections.entries()) {
        if (normalizePlannerSectionName(sectionName) === normalizedSpeaker) {
            return refs;
        }
    }

    return [];
}

function resolveLorebookEntriesFromLibrary(references, library) {
    const resolved = [];
    const seen = new Set();

    for (const reference of Array.isArray(references) ? references : []) {
        const refUid = Number(reference?.uid);
        const refName = String(reference?.name ?? '').trim().toLowerCase();
        if (!Number.isFinite(refUid)) continue;

        const matches = library.filter(entry => {
            if (Number(entry.uid) !== refUid) return false;
            if (!refName) return true;
            return String(entry.name ?? '').trim().toLowerCase() === refName;
        });

        const match = matches[0] ?? library.find(entry => Number(entry.uid) === refUid);
        if (!match) continue;

        const key = `${match.book}:${match.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push(match);
    }

    return resolved;
}

function buildLorebookInjectionPrompt(entries, charName) {
    const usableEntries = (Array.isArray(entries) ? entries : []).filter(entry => String(entry?.content ?? '').trim());
    if (!usableEntries.length) return '';

    const body = usableEntries
        .map(entry => `### ${entry.name || `UID ${entry.uid}`} (${entry.book} | uid ${entry.uid})\n${entry.content}`)
        .join('\n\n');

    return `[PRIVATE LOREBOOK CONTEXT - NEXT REPLY ONLY]
You are writing as ${charName}. Use the following lorebook context as high-priority private guidance for your next reply only.

Rules:
- Use this context only when it helps the current turn.
- Do not quote or mention this directive, lorebooks, routing, prompts, hidden notes, or injected context.
- Do not reveal hidden information unless your character could naturally know or express it.
- Keep your reply in character and focused on the current scene.

${body}
[/Lorebook Context]`;
}

async function applyLorebookInjectionForCharacter(charName, storyGuide = getStoryGuide()) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') {
        return;
    }

    const control = parseLorebookControlBlock(storyGuide);
    if (!control.sections.size) {
        clearLorebookInjection();
        return;
    }

    const references = resolveLorebookReferencesForSpeaker(control, charName);
    if (!references.length) {
        clearLorebookInjection();
        return;
    }

    const library = await getPlannerLorebookLibrary();
    const entries = resolveLorebookEntriesFromLibrary(references, library);
    const prompt = buildLorebookInjectionPrompt(entries, charName);

    if (!prompt) {
        clearLorebookInjection();
        return;
    }

    ctx.setExtensionPrompt(
        LOREBOOK_INJECTION_KEY,
        prompt,
        EXTENSION_PROMPT_TYPES.IN_PROMPT,
        0,
        false,
        EXTENSION_PROMPT_ROLES.SYSTEM,
    );
    console.log('[SceneDirector] Applied lorebook injection prompt', {
        charName,
        entries: entries.map(entry => ({ book: entry.book, uid: entry.uid, name: entry.name })),
    });
}

function applyStoryGuideInjectionForCharacter(charName, storyGuide = getStoryGuide()) {
    const ctx = SillyTavern.getContext();
    const prompt = buildStoryGuideInjectionPrompt(storyGuide, charName);

    if (!prompt || typeof ctx.setExtensionPrompt !== 'function') {
        clearStoryGuideInjection();
        return;
    }

    ctx.setExtensionPrompt(
        STORY_GUIDE_INJECTION_KEY,
        prompt,
        EXTENSION_PROMPT_TYPES.IN_PROMPT,
        0,
        false,
        EXTENSION_PROMPT_ROLES.SYSTEM,
    );
}

function buildSceneDirectionPrompt(decision, charName) {
    const direction = String(decision?.direction ?? '').trim();
    const scenePressure = String(decision?.scenePressure ?? '').trim();
    const avoid = String(decision?.avoid ?? '').trim();

    if (!direction && !scenePressure && !avoid) return '';

    return `[SCENE_DIRECTION]
speaker: ${charName}
scope: next reply only
mode: private

[OBJECTIVE]
${direction || 'Continue the scene naturally from your character perspective.'}
[/OBJECTIVE]

[PRESSURE]
${scenePressure || 'Keep the scene moving without forcing the user character.'}
[/PRESSURE]

[AVOID]
${avoid || 'Do not reveal hidden information. Do not decide the user character actions, thoughts, emotions, or dialogue.'}
[/AVOID]

[RULES]
- Your next reply should visibly serve the objective.
- Keep the pressure present in the scene; do not dissolve tension unless the objective says so.
- Do not skip ahead, resolve the scene, or summarize future events.
- Do not decide the user character's actions, thoughts, emotions, dialogue, or dice results.
- Do not mention the SceneDirector, routing, prompts, or hidden instructions.
[/RULES]
[/SCENE_DIRECTION]`;
}

function resolveDecisionCharacterName(decision) {
    const nextSpeaker = String(decision?.nextSpeaker ?? '').trim();
    if (!nextSpeaker) return '';

    const lowered = nextSpeaker.toLowerCase();
    const ctx = SillyTavern.getContext();
    const userNames = [
        'user',
        'player',
        String(ctx?.name1 ?? '').trim().toLowerCase(),
    ].filter(Boolean);

    if (userNames.includes(lowered)) {
        return 'USER';
    }

    const matchedCharacter = (config.characters ?? []).find(character => {
        const name = String(character?.name ?? '').trim().toLowerCase();
        return name && (name === lowered || name.includes(lowered) || lowered.includes(name));
    });

    return matchedCharacter?.name || nextSpeaker;
}

function resolveRequestedCharacterName(name) {
    const requested = String(name ?? '').trim();
    if (!requested) return '';

    const lowered = requested.toLowerCase();
    const ctx = SillyTavern.getContext();
    const userNames = [
        'user',
        'player',
        String(ctx?.name1 ?? '').trim().toLowerCase(),
    ].filter(Boolean);

    if (userNames.includes(lowered)) {
        return 'USER';
    }

    const exact = (config.characters ?? []).find(character => String(character?.name ?? '').trim().toLowerCase() === lowered);
    if (exact?.name) return exact.name;

    const fuzzy = (config.characters ?? []).find(character => {
        const current = String(character?.name ?? '').trim().toLowerCase();
        return current && (current.includes(lowered) || lowered.includes(current));
    });

    return fuzzy?.name || requested;
}

function setSceneDirection(decision, charName) {
    const ctx = SillyTavern.getContext();
    const prompt = buildSceneDirectionPrompt(decision, charName);

    if (!prompt || typeof ctx.setExtensionPrompt !== 'function') {
        clearSceneDirection();
        return;
    }

    ctx.setExtensionPrompt(
        SCENE_DIRECTION_KEY,
        prompt,
        EXTENSION_PROMPT_TYPES.IN_PROMPT,
        0,
        false,
        EXTENSION_PROMPT_ROLES.SYSTEM,
    );
    console.log('[SceneDirector] Applied scene direction prompt', {
        charName,
        key: SCENE_DIRECTION_KEY,
        position: EXTENSION_PROMPT_TYPES.IN_PROMPT,
        depth: 0,
        prompt,
        stored: ctx.extensionPrompts?.[SCENE_DIRECTION_KEY],
    });
}

function clearSceneDirection() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(
            SCENE_DIRECTION_KEY,
            '',
            EXTENSION_PROMPT_TYPES.IN_PROMPT,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    }
}

function clearLorebookInjection() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(
            LOREBOOK_INJECTION_KEY,
            '',
            EXTENSION_PROMPT_TYPES.IN_PROMPT,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    }
}

function clearStoryGuideInjection() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(
            STORY_GUIDE_INJECTION_KEY,
            '',
            EXTENSION_PROMPT_TYPES.IN_PROMPT,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    }
}

// ================= CONNECTION SERVICE =================

let _connService = null;
async function getConnService() {
    if (!_connService) {
        const mod = await import('/scripts/extensions/shared.js');
        _connService = mod.ConnectionManagerRequestService;
    }
    return _connService;
}

function resolveCharacterProfileForSwitch(char, ctx = SillyTavern.getContext()) {
    const profileId = String(char?.profileId ?? '').trim();
    const profileName = String(char?.profileName ?? '').trim();
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];

    if (profileId) {
        const matchedProfile = profiles.find(profile => String(profile?.id ?? '') === profileId);
        if (matchedProfile?.name) {
            return {
                profileId,
                profileName: String(matchedProfile.name),
                source: 'profileId',
            };
        }
    }

    if (profileName) {
        return {
            profileId,
            profileName,
            source: 'storedName',
        };
    }

    return {
        profileId,
        profileName: '',
        source: 'none',
    };
}

async function waitForChatRecovery(ctx, previousChatLength, timeoutMs = 4000) {
    const expectedMessages = Math.max(1, Number(previousChatLength) || 0);
    if (expectedMessages <= 0) {
        return true;
    }

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        const currentLength = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
        if (currentLength >= expectedMessages || currentLength > 0) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    return false;
}

// ================= WORLD INFO TEST =================

const WORLD_INFO_SCAN_TIMEOUT_MS = 3000;

function getCurrentCharacterField(ctx, fieldName) {
    const character = ctx.characters?.[ctx.characterId];
    const data = character?.data ?? character ?? {};
    return data[fieldName] ?? character?.[fieldName] ?? '';
}

function buildWorldInfoScanData(ctx) {
    return {
        personaDescription: ctx.chatMetadata?.persona ?? '',
        characterDescription: getCurrentCharacterField(ctx, 'description'),
        characterPersonality: getCurrentCharacterField(ctx, 'personality'),
        characterDepthPrompt: getCurrentCharacterField(ctx, 'depth_prompt'),
        scenario: ctx.chatMetadata?.scenario || getCurrentCharacterField(ctx, 'scenario'),
        creatorNotes: getCurrentCharacterField(ctx, 'creator_notes') || getCurrentCharacterField(ctx, 'creatorcomment'),
        trigger: 'normal',
    };
}

function buildWorldInfoChat(ctx) {
    return ctx.chat
        .filter(m => !m.is_system && m.mes != null && String(m.mes).trim() && !isBackstageOocMessage(m.mes))
        .map(m => `${m.name || 'Unknown'}: ${m.mes}`)
        .reverse();
}

function waitForWorldInfoScan(ctx) {
    const eventName = ctx.event_types?.WORLDINFO_SCAN_DONE || ctx.eventTypes?.WORLDINFO_SCAN_DONE;
    if (!eventName || typeof ctx.eventSource?.once !== 'function') {
        return Promise.resolve(null);
    }

    return new Promise(resolve => {
        let resolved = false;
        const finish = (scan) => {
            if (resolved) return;
            resolved = true;
            resolve(scan);
        };

        ctx.eventSource.once(eventName, finish);
        setTimeout(() => finish(null), WORLD_INFO_SCAN_TIMEOUT_MS);
    });
}

async function getWorldInfoModule() {
    return import('/scripts/world-info.js');
}

function getAvailableWorldInfoNames(wi = null) {
    if (Array.isArray(wi?.world_names) && wi.world_names.length) {
        return wi.world_names;
    }

    return $('#world_info option')
        .map((_, option) => String($(option).text() || '').trim())
        .get()
        .filter(Boolean);
}

function getRouterTimedLorebookConfig() {
    return {
        book: String(config.routerTimedLorebookBook ?? '').trim(),
        uid: Number(config.routerTimedLorebookUid),
        name: String(config.routerTimedLorebookName ?? '').trim(),
        triggerRegex: String(config.routerTimedLorebookTriggerRegex ?? '').trim(),
    };
}

function getRealChatTurnCount(ctx = SillyTavern.getContext()) {
    return (ctx.chat ?? []).filter(m =>
        !m.is_system &&
        m.extra?.type !== 'tool_call' &&
        m.extra?.type !== 'tool_response' &&
        m.mes != null &&
        String(m.mes).trim() &&
        !isBackstageOocMessage(m.mes)
    ).length;
}

function tryBuildRouterTimedLorebookRegex() {
    const source = String(config.routerTimedLorebookTriggerRegex ?? '').trim();
    if (!source) return null;

    const wrappedMatch = source.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    try {
        if (wrappedMatch) {
            return new RegExp(wrappedMatch[1], wrappedMatch[2] || 'i');
        }

        return new RegExp(source, 'i');
    } catch (error) {
        console.warn('[SceneDirector] Invalid timed lorebook regex:', source, error);
        return null;
    }
}

function getRouterTimedLorebookCachedEntry() {
    const timedConfig = getRouterTimedLorebookConfig();
    if (!timedConfig.book || !Number.isFinite(timedConfig.uid) || timedConfig.uid <= 0) {
        return null;
    }

    const entries = routerTimedLorebookEntryCache.get(timedConfig.book) ?? [];
    return entries.find(entry => entry.uid === timedConfig.uid) ?? null;
}

function getRouterTimedLorebookEffectMode(entry) {
    if (!entry) return '';
    if (Number(entry.sticky) > 0) return 'sticky';
    if (Number(entry.cooldown) > 0) return 'cooldown';
    return '';
}

async function getRouterTimedLorebookEntries(bookName) {
    const cleanBookName = String(bookName ?? '').trim();
    if (!cleanBookName) return [];
    if (routerTimedLorebookEntryCache.has(cleanBookName)) {
        return routerTimedLorebookEntryCache.get(cleanBookName) ?? [];
    }

    const wi = await getWorldInfoModule();
    if (typeof wi.loadWorldInfo !== 'function') {
        return [];
    }

    const data = await wi.loadWorldInfo(cleanBookName);
    const entries = Object.values(data?.entries ?? {})
        .map(entry => {
            const comment = String(entry?.comment ?? '').trim();
            const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : '';
            const content = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
            const preview = content.slice(0, 140);
            return {
                uid: Number(entry?.uid),
                comment,
                keys,
                preview,
                disable: !!entry?.disable,
                sticky: Number(entry?.sticky) || 0,
                cooldown: Number(entry?.cooldown) || 0,
                content,
                label: comment || preview || `UID ${entry?.uid}`,
                searchText: [comment, keys, content, String(entry?.uid ?? '')].join(' ').toLowerCase(),
            };
        })
        .filter(entry => Number.isFinite(entry.uid))
        .sort((a, b) => {
            const aLabel = a.label.toLowerCase();
            const bLabel = b.label.toLowerCase();
            return aLabel.localeCompare(bLabel) || a.uid - b.uid;
        });

    routerTimedLorebookEntryCache.set(cleanBookName, entries);
    return entries;
}

function summarizeWorldInfoEntries(scan) {
    const entries = scan?.activated?.entries;
    if (!entries || typeof entries.values !== 'function') return [];

    return [...entries.values()].map(entry => ({
        world: entry.world,
        uid: entry.uid,
        comment: entry.comment,
        key: entry.key,
        keysecondary: entry.keysecondary,
        position: entry.position,
        depth: entry.depth,
        content: entry.content,
    }));
}

function formatWorldInfoBlockValue(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

function formatWorldInfoPromptResult(result) {
    const parts = [];
    const before = String(result?.worldInfoBefore ?? '').trim();
    const after = String(result?.worldInfoAfter ?? '').trim();
    const examples = Array.isArray(result?.worldInfoExamples) ? result.worldInfoExamples : [];
    const depth = Array.isArray(result?.worldInfoDepth) ? result.worldInfoDepth : [];
    const outlets = result?.outletEntries && Object.keys(result.outletEntries).length
        ? JSON.stringify(result.outletEntries, null, 2)
        : '';

    if (before) parts.push(`# World Info Before\n${before}`);
    if (after) parts.push(`# World Info After\n${after}`);
    if (examples.length) parts.push(`# World Info Examples\n${examples.map(formatWorldInfoBlockValue).join('\n\n')}`);
    if (depth.length) parts.push(`# World Info Depth\n${depth.map(formatWorldInfoBlockValue).join('\n\n')}`);
    if (outlets) parts.push(`# World Info Outlets\n${outlets}`);

    return parts.join('\n\n');
}

async function getSelectedWorldInfoContext(ctx, selectedBooks = config.plannerWorldInfoBooks) {
    const books = (Array.isArray(selectedBooks) ? selectedBooks : [])
        .map(name => String(name ?? '').trim())
        .filter(Boolean);

    if (!books.length) {
        return {
            text: '',
            source: 'none-selected',
            selectedBooks: [],
            activatedEntries: [],
            length: 0,
        };
    }

    if (typeof ctx.getWorldInfoPrompt !== 'function') {
        return {
            text: '',
            source: 'ctx.getWorldInfoPrompt-unavailable',
            selectedBooks: books,
            activatedEntries: [],
            length: 0,
        };
    }

    const wi = await getWorldInfoModule();
    const originalSettings = wi.getWorldInfoSettings();
    const originalSelected = Array.isArray(wi.selected_world_info) ? [...wi.selected_world_info] : [];
    const availableBooks = getAvailableWorldInfoNames(wi);
    const validBooks = books.filter(name => availableBooks.includes(name));

    if (!validBooks.length) {
        return {
            text: '',
            source: 'no-valid-books',
            selectedBooks: books,
            activatedEntries: [],
            length: 0,
        };
    }

    const chatForWI = buildWorldInfoChat(ctx);
    const globalScanData = buildWorldInfoScanData(ctx);
    const scanPromise = waitForWorldInfoScan(ctx);

    try {
        wi.updateWorldInfoSettings({ ...originalSettings }, validBooks);
        const result = await ctx.getWorldInfoPrompt(chatForWI, ctx.maxContext, true, globalScanData);
        const scan = await scanPromise;
        const activatedEntries = summarizeWorldInfoEntries(scan);
        const text = formatWorldInfoPromptResult(result);

        return {
            text,
            source: 'selected-world-info',
            selectedBooks: validBooks,
            activatedEntries,
            length: text.length,
        };
    } finally {
        wi.updateWorldInfoSettings({ ...originalSettings }, originalSelected);
    }
}

async function getSelectedWorldInfoCatalog(selectedBooks = config.plannerWorldInfoBooks) {
    const books = (Array.isArray(selectedBooks) ? selectedBooks : [])
        .map(name => String(name ?? '').trim())
        .filter(Boolean);

    if (!books.length) {
        return {
            text: '',
            source: 'none-selected',
            selectedBooks: [],
            entryCount: 0,
        };
    }

    try {
        const wi = await getWorldInfoModule();
        const availableBooks = getAvailableWorldInfoNames(wi);
        const validBooks = books.filter(name => availableBooks.includes(name));

        if (!validBooks.length || typeof wi.loadWorldInfo !== 'function') {
            return {
                text: '',
                source: !validBooks.length ? 'no-valid-books' : 'loadWorldInfo-unavailable',
                selectedBooks: books,
                entryCount: 0,
            };
        }

        const chunks = [];
        let entryCount = 0;

        for (const bookName of validBooks) {
            const data = await wi.loadWorldInfo(bookName);
            const entries = Object.values(data?.entries ?? {});
            entryCount += entries.length;

            const lines = entries.map(entry => {
                const uid = String(entry?.uid ?? '').trim();
                const comment = String(entry?.comment ?? '').trim();
                const keys = Array.isArray(entry?.key)
                    ? entry.key.map(value => String(value ?? '').trim()).filter(Boolean)
                    : [];
                const content = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
                const flags = [
                    entry?.disable ? 'disabled' : 'enabled',
                    entry?.constant ? 'constant' : '',
                ].filter(Boolean);

                return [
                    `- UID: ${uid || '?'}`,
                    comment ? `Name: ${comment}` : '',
                    keys.length ? `Keys: ${keys.join(', ')}` : '',
                    flags.length ? `Flags: ${flags.join(', ')}` : '',
                    content ? `Content: ${content.slice(0, 220)}${content.length > 220 ? '...' : ''}` : '',
                ].filter(Boolean).join(' | ');
            });

            chunks.push(`## ${bookName}\n${lines.join('\n') || '- (empty)'}`);
        }

        return {
            text: chunks.join('\n\n'),
            source: 'selected-world-info-catalog',
            selectedBooks: validBooks,
            entryCount,
        };
    } catch (error) {
        console.warn('[SceneDirector] Failed to build World Info catalog:', error);
        return {
            text: '',
            source: 'error',
            selectedBooks: books,
            entryCount: 0,
        };
    }
}

function isRouterTimedLorebookGmMessage(message) {
    const name = String(message?.name ?? '').trim();
    return /\bgm\b/i.test(name);
}

async function maybeTriggerRouterTimedLorebookFromMessage(message, ctx = SillyTavern.getContext()) {
    const timedConfig = getRouterTimedLorebookConfig();
    const regex = tryBuildRouterTimedLorebookRegex();

    if (!timedConfig.book || !Number.isFinite(timedConfig.uid) || timedConfig.uid <= 0 || !regex) {
        return null;
    }

    if (!isRouterTimedLorebookGmMessage(message)) {
        return null;
    }

    const content = String(message?.mes ?? '').trim();
    if (!content || !regex.test(content)) {
        return null;
    }

    const signature = [
        String(ctx.groupId ?? ctx.characterId ?? ''),
        (ctx.chat ?? []).length - 1,
        String(message?.name ?? '').trim(),
        content,
        timedConfig.book,
        timedConfig.uid,
    ].join('|');

    if (routerTimedLorebookLastTriggerSignature === signature) {
        return null;
    }

    try {
        const entries = await getRouterTimedLorebookEntries(timedConfig.book);
        const entry = entries.find(item => item.uid === timedConfig.uid);
        if (!entry) {
            console.warn('[SceneDirector] Timed lorebook trigger target entry not found:', timedConfig);
            return null;
        }

        const effect = getRouterTimedLorebookEffectMode(entry);
        if (!effect) {
            console.warn('[SceneDirector] Timed lorebook trigger target has no sticky/cooldown configured:', {
                book: timedConfig.book,
                uid: timedConfig.uid,
                sticky: entry.sticky,
                cooldown: entry.cooldown,
            });
            return null;
        }

        const escapedBook = timedConfig.book.replace(/"/g, '\\"');
        await ctx.executeSlashCommandsWithOptions(`/wi-set-timed-effect file="${escapedBook}" uid=${timedConfig.uid} effect=${effect} on`);
        routerTimedLorebookLastTriggerSignature = signature;
        console.log('[SceneDirector] Triggered timed lorebook effect from GM message', {
            book: timedConfig.book,
            uid: timedConfig.uid,
            effect,
            regex: timedConfig.triggerRegex,
            speaker: message?.name,
        });
        return { effect, entry };
    } catch (error) {
        console.warn('[SceneDirector] Failed to trigger timed lorebook effect from GM message:', error);
        return null;
    }
}

async function testWorldInfoPrompt(caller = 'manual') {
    const ctx = SillyTavern.getContext();

    if (typeof ctx.getWorldInfoPrompt !== 'function') {
        console.warn('[RP Router][WI Test] ctx.getWorldInfoPrompt is not available in this SillyTavern build.', ctx);
        toastr.error('ctx.getWorldInfoPrompt nao esta disponivel.', 'RP Router');
        return null;
    }

    const chatForWI = buildWorldInfoChat(ctx);
    const globalScanData = buildWorldInfoScanData(ctx);
    const scanPromise = waitForWorldInfoScan(ctx);

    console.group(`[RP Router][WI Test] ${caller}`);
    console.log('Input', {
        chatMessages: chatForWI.length,
        maxContext: ctx.maxContext,
        groupId: ctx.groupId,
        chatId: ctx.chatId,
        globalScanData,
    });

    try {
        const result = await ctx.getWorldInfoPrompt(chatForWI, ctx.maxContext, true, globalScanData);
        const scan = await scanPromise;
        const activatedEntries = summarizeWorldInfoEntries(scan);

        console.log('WorldInfo result', result);
        console.log('worldInfoBefore', result.worldInfoBefore || '');
        console.log('worldInfoAfter', result.worldInfoAfter || '');
        console.log('worldInfoString', result.worldInfoString || '');
        console.log('worldInfoDepth', result.worldInfoDepth || []);
        console.log('worldInfoExamples', result.worldInfoExamples || []);
        console.log('outletEntries', result.outletEntries || {});
        console.log('WORLDINFO_SCAN_DONE raw', scan);
        console.table(activatedEntries.map(entry => ({
            world: entry.world,
            uid: entry.uid,
            comment: entry.comment,
            keys: Array.isArray(entry.key) ? entry.key.join(', ') : '',
            position: entry.position,
            depth: entry.depth,
        })));
        console.log('Activated entries', activatedEntries);

        toastr.info(`WI dry-run: ${activatedEntries.length} entradas ativadas. Veja o console.`, 'RP Router');
        return { result, scan, activatedEntries };
    } catch (error) {
        console.error('[RP Router][WI Test] Error while testing World Info prompt:', error);
        toastr.error('Erro no teste de World Info. Veja o console.', 'RP Router');
        return null;
    } finally {
        console.groupEnd();
    }
}

// ================= VECTFOX TEST =================

async function getExtensionSettings() {
    try {
        const mod = await import('/scripts/extensions.js');
        return mod.extension_settings ?? window.extension_settings ?? null;
    } catch (error) {
        console.warn('[RP Router][VectFox Test] Could not import extension_settings:', error);
        return window.extension_settings ?? null;
    }
}

function getVectFoxSettings(extensionSettings) {
    return extensionSettings?.vectfox ?? null;
}

function buildVectFoxRecentMessages(ctx, settings) {
    const depth = Number(settings?.world_info_query_depth || settings?.query || 3);
    return [...(ctx.chat ?? [])]
        .filter(m => !m.is_system && m.extra?.type !== 'tool_call' && m.extra?.type !== 'tool_response')
        .filter(m => m.mes != null && String(m.mes).trim())
        .reverse()
        .slice(0, Math.max(1, depth))
        .map(m => {
            const text = String(m.mes ?? '');
            return typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text;
        });
}

function getLastUserMessage(ctx) {
    const message = [...(ctx.chat ?? [])]
        .reverse()
        .find(m => !m.is_system && m.is_user && m.mes != null && String(m.mes).trim());

    return message ? String(message.mes).trim() : null;
}

function summarizeVectFoxEntries(entries) {
    if (!Array.isArray(entries)) return [];

    return entries.map(entry => ({
        world: entry.world ?? entry.worldName ?? entry.sourceWorld ?? '',
        uid: entry.uid ?? entry.id ?? '',
        comment: entry.comment ?? entry.title ?? entry.name ?? '',
        score: entry.score ?? entry.similarity ?? entry.distance ?? '',
        key: Array.isArray(entry.key) ? entry.key.join(', ') : entry.key ?? '',
        contentLength: String(entry.content ?? '').length,
        content: entry.content ?? '',
    }));
}

function formatVectFoxLorebookInjection(entries, settings) {
    if (!Array.isArray(entries) || !entries.length) return '';

    const tag = settings?.lorebook_xml_tag || 'VectFoxLorebook';
    const blocks = entries
        .filter(entry => String(entry.content ?? '').trim())
        .map(entry => {
            const title = entry.comment || entry.title || entry.name || entry.uid || 'entry';
            return `### ${title}\n${entry.content}`;
        });

    if (!blocks.length) return '';

    return `<${tag}>\n${blocks.join('\n\n')}\n</${tag}>`;
}

function inspectVectFoxExtensionPrompts(ctx) {
    const prompts = ctx.extensionPrompts ?? {};

    return Object.entries(prompts)
        .filter(([key, prompt]) => /vectfox|vector|rag|memory/i.test(`${key} ${prompt?.value ?? ''}`))
        .map(([key, prompt]) => ({
            key,
            position: prompt?.position,
            depth: prompt?.depth,
            length: String(prompt?.value ?? '').length,
            value: prompt?.value ?? '',
        }));
}

function summarizeVectFoxPrompts(prompts) {
    if (!Array.isArray(prompts)) return [];

    return prompts.map(prompt => ({
        key: prompt.key,
        length: prompt.length,
        position: prompt.position,
        depth: prompt.depth,
        valueStart: String(prompt.value ?? '').slice(0, 300),
    }));
}

async function importFirstAvailable(paths) {
    for (const path of paths) {
        try {
            const mod = await import(path);
            return { mod, path };
        } catch (_) {
            // Optional probe: VectFox may not be installed under this path.
        }
    }

    return null;
}

async function runVectFoxLorebookDryRun(ctx, settings) {
    const imported = await importFirstAvailable([
        '/scripts/extensions/third-party/VectFox/core/world-info-integration.js',
        '/scripts/extensions/third-party/vectfox/core/world-info-integration.js',
    ]);

    if (typeof imported?.mod?.runLorebookWIDryRun !== 'function') {
        return { importedPath: imported?.path ?? null, result: null };
    }

    const result = await imported.mod.runLorebookWIDryRun({
        chat: ctx.chat ?? [],
        testMessage: getLastUserMessage(ctx),
        settings,
    });

    return { importedPath: imported.path, result };
}

function limitText(text, maxChars) {
    const value = String(text ?? '');
    const limit = Math.max(0, Number(maxChars || 0));

    if (limit === 0 || value.length <= limit) return value;

    return `${value.slice(0, limit)}\n\n[Context truncated to ${limit} characters.]`;
}

async function getVectFoxRouterContext(ctx) {
    const maxChars = Number(config.worldContextChars || 0);

    if (maxChars <= 0) {
        return { text: '', source: 'vectfox-skipped-by-config', entryCount: 0, originalLength: 0, truncated: false };
    }

    try {
        const extensionSettings = await getExtensionSettings();
        const settings = getVectFoxSettings(extensionSettings);

        if (!settings?.enabled_world_info) {
            return { text: '', source: 'vectfox-disabled', entryCount: 0, originalLength: 0 };
        }

        const dryRun = await runVectFoxLorebookDryRun(ctx, settings);
        const injectionText = String(dryRun?.result?.injectionText ?? '');

        return {
            text: limitText(injectionText, maxChars),
            source: dryRun?.importedPath ?? 'vectfox',
            entryCount: Number(dryRun?.result?.entryCount ?? 0),
            originalLength: injectionText.length,
            truncated: maxChars > 0 && injectionText.length > maxChars,
        };
    } catch (error) {
        console.warn('[SceneDirector] Failed to get VectFox router context:', error);
        return { text: '', source: 'error', entryCount: 0, originalLength: 0, error };
    }
}

function buildVectFoxRuntimeSummary(settings) {
    const vectFoxWorldInfo = window.VectFox_WorldInfo ?? null;

    return {
        hasSettings: !!settings,
        enabled: settings?.enabled,
        enabledWorldInfo: settings?.enabled_world_info,
        worldInfoTopK: settings?.world_info_top_k,
        worldInfoQueryDepth: settings?.world_info_query_depth,
        lorebookXmlTag: settings?.lorebook_xml_tag,
        hasVectFoxWorldInfo: !!vectFoxWorldInfo,
        vectFoxWorldInfoMethods: Object.keys(vectFoxWorldInfo ?? {}),
        hasRearrangeChat: typeof window.vectfox_rearrangeChat === 'function',
    };
}

function buildVectFoxCompactResult(data) {
    const semanticEntries = Array.isArray(data.semanticEntries) ? data.semanticEntries : [];
    const dryRunText = data.lorebookDryRun?.result?.injectionText ?? '';

    return {
        runtime: data.runtime,
        query: {
            chatMessages: data.chatMessages,
            recentMessageCount: data.recentMessages?.length ?? 0,
            recentMessagesStart: (data.recentMessages ?? []).map(text => String(text ?? '').slice(0, 180)),
            keywordQuery: String(data.keywordQuery ?? '').slice(0, 300),
        },
        dryRun: {
            importedPath: data.lorebookDryRun?.importedPath ?? null,
            entryCount: data.lorebookDryRun?.result?.entryCount ?? null,
            disabled: data.lorebookDryRun?.result?.disabled ?? false,
            noCollections: data.lorebookDryRun?.result?.noCollections ?? false,
            injectionLength: String(dryRunText).length,
            injectionStart: String(dryRunText).slice(0, 1200),
        },
        semantic: {
            count: semanticEntries.length,
            entries: summarizeVectFoxEntries(semanticEntries).slice(0, 12).map(entry => ({
                world: entry.world,
                uid: entry.uid,
                comment: entry.comment,
                score: entry.score,
                key: entry.key,
                contentLength: entry.contentLength,
                contentStart: String(entry.content ?? '').slice(0, 260),
            })),
            injectionLength: String(data.semanticInjectionText ?? '').length,
            injectionStart: String(data.semanticInjectionText ?? '').slice(0, 1200),
        },
        existingPrompts: summarizeVectFoxPrompts(data.existingPrompts),
    };
}

async function testVectFoxPrompt(caller = 'manual', options = {}) {
    const verbose = options?.verbose === true;
    const ctx = SillyTavern.getContext();
    const extensionSettings = await getExtensionSettings();
    const settings = getVectFoxSettings(extensionSettings);
    const runtime = buildVectFoxRuntimeSummary(settings);
    const existingPrompts = inspectVectFoxExtensionPrompts(ctx);

    console.group(`[RP Router][VectFox Test] ${caller}`);
    console.log('Runtime', runtime);
    console.log('Existing VectFox-ish extension prompts summary', summarizeVectFoxPrompts(existingPrompts));
    if (verbose) console.log('Existing VectFox-ish extension prompts full', existingPrompts);

    if (!settings) {
        console.warn('[RP Router][VectFox Test] extension_settings.vectfox was not found.');
        toastr.warning('VectFox settings nao encontradas. Veja o console.', 'RP Router');
        console.groupEnd();
        return { runtime, existingPrompts };
    }

    const recentMessages = buildVectFoxRecentMessages(ctx, settings);
    const keywordQuery = getLastUserMessage(ctx);

    console.log('Query input', {
        recentMessageCount: recentMessages.length,
        recentMessagesStart: recentMessages.map(text => String(text ?? '').slice(0, 180)),
        keywordQuery,
        chatMessages: ctx.chat?.length ?? 0,
        groupId: ctx.groupId,
        chatId: ctx.chatId,
    });

    try {
        let semanticEntries = null;
        let semanticInjectionText = '';

        if (typeof window.VectFox_WorldInfo?.getSemanticEntries === 'function') {
            semanticEntries = await window.VectFox_WorldInfo.getSemanticEntries(
                recentMessages,
                [],
                settings,
                keywordQuery,
            );
            semanticInjectionText = formatVectFoxLorebookInjection(semanticEntries, settings);

            const summarizedEntries = summarizeVectFoxEntries(semanticEntries);
            console.table(summarizedEntries.map(entry => ({
                world: entry.world,
                uid: entry.uid,
                comment: entry.comment,
                score: entry.score,
                contentLength: entry.contentLength,
            })));
            console.log('Semantic injection preview', semanticInjectionText.slice(0, 1200));
            if (verbose) {
                console.log('Semantic entries raw', semanticEntries);
                console.log('Semantic injection full', semanticInjectionText);
            }
        } else {
            console.warn('[RP Router][VectFox Test] window.VectFox_WorldInfo.getSemanticEntries is not available.');
        }

        const lorebookDryRun = await runVectFoxLorebookDryRun(ctx, settings);
        const compact = buildVectFoxCompactResult({
            runtime,
            chatMessages: ctx.chat?.length ?? 0,
            recentMessages,
            keywordQuery,
            semanticEntries,
            semanticInjectionText,
            lorebookDryRun,
            existingPrompts,
        });

        console.log('Compact result', compact);
        if (verbose) console.log('VectFox runLorebookWIDryRun full', lorebookDryRun);

        const entryCount = Array.isArray(semanticEntries)
            ? semanticEntries.length
            : Number(lorebookDryRun?.result?.entryCount ?? 0);

        toastr.info(`VectFox dry-run: ${entryCount} entradas. Veja o console.`, 'RP Router');
        return {
            runtime,
            recentMessages,
            keywordQuery,
            semanticEntries,
            semanticInjectionText,
            lorebookDryRun,
            existingPrompts,
            compact,
        };
    } catch (error) {
        console.error('[RP Router][VectFox Test] Error while testing VectFox:', error);
        toastr.error('Erro no teste do VectFox. Veja o console.', 'RP Router');
        return null;
    } finally {
        console.groupEnd();
    }
}

// ================= ROUTER =================

function renderTemplate(template, values) {
    const normalizedValues = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
    );

    return String(template ?? '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
        const value = normalizedValues[String(key).toLowerCase()];
        return value == null ? match : String(value);
    });
}

function ensureRouterPromptHasStoryGuide(template, storyGuide) {
    const source = String(template ?? '');
    if (!String(storyGuide ?? '').trim()) {
        return source;
    }

    if (/{{\s*storyGuide\s*}}/i.test(source)) {
        return source;
    }

    const storyGuideBlock = `StoryGuide:\n{{storyGuide}}\n\n`;
    const returnMarker = /\nReturn:\s*/i;

    if (returnMarker.test(source)) {
        return source.replace(returnMarker, `\n${storyGuideBlock}Return:\n`);
    }

    return `${source.trim()}\n\n${storyGuideBlock}`.trim();
}

function ensureRouterPromptHasLorebookBlocks(template, lorebookContext, lorebookCatalog) {
    let source = String(template ?? '');
    const returnMarker = /\nReturn:\s*/i;

    if (String(lorebookContext ?? '').trim() && !/{{\s*lorebookContext\s*}}/i.test(source)) {
        const block = `Selected lorebook context:\n{{lorebookContext}}\n\n`;
        source = returnMarker.test(source)
            ? source.replace(returnMarker, `\n${block}Return:\n`)
            : `${source.trim()}\n\n${block}`.trim();
    }

    if (String(lorebookCatalog ?? '').trim() && !/{{\s*lorebookCatalog\s*}}/i.test(source)) {
        const block = `Selected lorebook catalog:\n{{lorebookCatalog}}\n\n`;
        source = returnMarker.test(source)
            ? source.replace(returnMarker, `\n${block}Return:\n`)
            : `${source.trim()}\n\n${block}`.trim();
    }

    return source;
}

function buildRouterSystemPrompt(routerContext) {
    let routerPromptTemplate = ensureRouterPromptHasStoryGuide(config.routerPrompt, routerContext.storyGuide);
    routerPromptTemplate = ensureRouterPromptHasLorebookBlocks(
        routerPromptTemplate,
        routerContext.lorebookContext?.text,
        routerContext.lorebookCatalog?.text,
    );

    return renderTemplate(routerPromptTemplate, {
        lastSpeaker: routerContext.lastSpeaker,
        players: routerContext.playerNames,
        recentChat: routerContext.recentChat,
        worldContext: routerContext.worldContext.text,
        storyGuide: routerContext.storyGuide,
        lorebookContext: routerContext.lorebookContext?.text ?? '',
        lorebookCatalog: routerContext.lorebookCatalog?.text ?? '',
        user: routerContext.humanName,
    });
}

function buildRouterMessages(routerContext, options = {}) {
    const systemPrompt = buildRouterSystemPrompt(routerContext);

    if (options.mode === 'ooc') {
        return [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'system',
                content: 'Router workspace mode. Respond directly to the operator in OOC. Do not return runtime-only JSON unless the operator explicitly asks for it. Do not trigger characters or narrate chat prose.',
            },
            {
                role: 'system',
                content: `Current routing context:
Last speaker: ${routerContext.lastSpeaker}
Characters: ${routerContext.playerNames || '(none)'}

Recent chat:
${routerContext.recentChat || '(empty)'}

World context:
${routerContext.worldContext.text || '(empty)'}

Selected lorebook context:
${routerContext.lorebookContext?.text || '(empty)'}

Selected lorebook catalog:
${routerContext.lorebookCatalog?.text || '(empty)'}

StoryGuide:
${routerContext.storyGuide || '(empty)'}

Treat the messages that follow as an ongoing OOC conversation with the operator about routing and next-turn direction.`,
            },
            ...(Array.isArray(options.priorHistory) ? options.priorHistory : []),
            {
                role: 'user',
                content: String(options.oocRequest ?? '').trim(),
            },
        ];
    }

    const forcedSpeakerInstruction = buildForcedSpeakerInstruction(options.forcedSpeaker);
    const promptIncludesRecentChat = /{{\s*recentChat\s*}}/i.test(config.routerPrompt);

    return [
        { role: 'system', content: systemPrompt },
        ...(forcedSpeakerInstruction ? [{ role: 'user', content: forcedSpeakerInstruction }] : []),
        { role: 'user', content: promptIncludesRecentChat ? 'Return the SceneDirector JSON now.' : routerContext.recentChat },
    ];
}

function serializePromptMessagesForBudget(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map((message, index) => `# ${index + 1}. ${String(message?.role ?? 'user').toUpperCase()}\n\n${String(message?.content ?? '')}`)
        .join('\n\n');
}

async function estimateRequestInputTokens(profileId, messages, service = null) {
    const ctx = SillyTavern.getContext();
    const requestService = service ?? await getConnService();
    const constructedPrompt = requestService?.constructPrompt
        ? requestService.constructPrompt(messages, profileId)
        : messages;
    const text = typeof constructedPrompt === 'string'
        ? constructedPrompt
        : serializePromptMessagesForBudget(constructedPrompt);

    return await ctx.getTokenCountAsync(text);
}

function shrinkTextBlock(text, options = {}) {
    const source = String(text ?? '').trim();
    if (!source) return '';

    const ratio = Math.min(0.5, Math.max(0.05, Number(options.ratio) || 0.18));
    const dropFromStart = !!options.dropFromStart;
    const lines = source.split('\n');

    if (lines.length > 1) {
        const delta = Math.max(1, Math.ceil(lines.length * ratio));
        const nextLines = dropFromStart
            ? lines.slice(delta)
            : lines.slice(0, Math.max(1, lines.length - delta));
        return nextLines.join('\n').trim();
    }

    const keepChars = Math.max(80, Math.floor(source.length * (1 - ratio)));
    if (keepChars >= source.length) {
        return source;
    }

    return dropFromStart
        ? source.slice(source.length - keepChars).trim()
        : source.slice(0, keepChars).trim();
}

function shrinkObjectTextField(target, options = {}) {
    if (!target || typeof target.text !== 'string') return false;
    const current = String(target.text ?? '').trim();
    const next = shrinkTextBlock(current, options);
    if (!next || next === current) return false;
    target.text = next;
    return true;
}

function shrinkPlainTextField(object, fieldName, options = {}) {
    const current = String(object?.[fieldName] ?? '').trim();
    const next = shrinkTextBlock(current, options);
    if (!next || next === current) return false;
    object[fieldName] = next;
    return true;
}

async function fitRouterMessagesToInputBudget(profileId, routerContext, buildMessagesFn) {
    const budget = Math.max(0, Number(config.routerInputTokenBudget || 0));
    const requestService = await getConnService();
    const workingContext = JSON.parse(JSON.stringify(routerContext ?? {}));
    let messages = buildMessagesFn(workingContext);
    let inputTokens = await estimateRequestInputTokens(profileId, messages, requestService);
    let trimmed = false;

    if (!budget || inputTokens <= budget) {
        return {
            messages,
            routerContext: workingContext,
            inputTokens,
            budget,
            trimmed,
        };
    }

    const shrinkers = [
        () => shrinkObjectTextField(workingContext.lorebookCatalog, { ratio: 0.25 }),
        () => shrinkObjectTextField(workingContext.lorebookContext, { ratio: 0.2 }),
        () => shrinkObjectTextField(workingContext.worldContext, { ratio: 0.2 }),
        () => shrinkPlainTextField(workingContext, 'storyGuide', { ratio: 0.18 }),
        () => shrinkPlainTextField(workingContext, 'recentChat', { ratio: 0.2, dropFromStart: true }),
    ];

    let changed = true;
    while (inputTokens > budget && changed) {
        changed = false;

        for (const shrink of shrinkers) {
            if (!shrink()) {
                continue;
            }

            trimmed = true;
            changed = true;
            messages = buildMessagesFn(workingContext);
            inputTokens = await estimateRequestInputTokens(profileId, messages, requestService);

            if (inputTokens <= budget) {
                break;
            }
        }
    }

    return {
        messages,
        routerContext: workingContext,
        inputTokens,
        budget,
        trimmed,
    };
}

function buildForcedSpeakerInstruction(forcedSpeaker) {
    const resolvedName = resolveRequestedCharacterName(forcedSpeaker);
    if (!resolvedName) return '';

    if (resolvedName === 'USER') {
        return `Override for this run:
- Do not route normally.
- Return JSON with nextSpeaker exactly "USER".
- direction must be empty or exactly "Wait for the player's input."
- scenePressure should state what is at stake now.
- avoid should state what NPCs must not resolve before the player acts.`;
    }

    return `Override for this run:
- Do not route normally.
- Return JSON with nextSpeaker exactly "${resolvedName}".
- Generate reason, direction, scenePressure, and avoid specifically for ${resolvedName}.
- Do not choose any other speaker.`;
}

function extractResponseText(response) {
    if (typeof response === 'string') return response.trim();
    if (response?.text) return String(response.text).trim();
    if (response?.choices?.[0]?.message?.content) return String(response.choices[0].message.content).trim();
    if (response?.content) return String(response.content).trim();
    return '';
}

function stripJsonFence(text) {
    return String(text ?? '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseSceneDirectorDecision(text) {
    const raw = String(text ?? '').trim();
    const unfenced = stripJsonFence(raw);
    const jsonStart = unfenced.indexOf('{');
    const jsonEnd = unfenced.lastIndexOf('}');

    if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
            const parsed = JSON.parse(unfenced.slice(jsonStart, jsonEnd + 1));
            return {
                nextSpeaker: String(parsed.nextSpeaker ?? parsed.speaker ?? parsed.character ?? '').trim(),
                reason: String(parsed.reason ?? '').trim(),
                direction: String(parsed.direction ?? '').trim(),
                scenePressure: String(parsed.scenePressure ?? parsed.pressure ?? '').trim(),
                avoid: String(parsed.avoid ?? '').trim(),
                raw,
                parsed,
            };
        } catch (error) {
            console.warn('[SceneDirector] Failed to parse JSON response, falling back to raw text:', error, raw);
        }
    }

    return {
        nextSpeaker: raw,
        reason: '',
        direction: '',
        scenePressure: '',
        avoid: '',
        raw,
        parsed: null,
    };
}

function updateSceneDirectorState(patch) {
    sceneDirectorState = {
        ...sceneDirectorState,
        ...patch,
    };
    refreshSceneDirectorPanel();
}

function updateRouterState(patch) {
    const normalized = { ...patch };
    if (Object.hasOwn(normalized, 'status')) {
        normalized.routerStatus = normalized.status;
        delete normalized.status;
    }

    sceneDirectorState = {
        ...sceneDirectorState,
        ...normalized,
        routerUpdatedAt: new Date(),
    };
    refreshSceneDirectorPanel();
}

function updateStoryDirectorState(patch) {
    const normalized = { ...patch };
    if (Object.hasOwn(normalized, 'status')) {
        normalized.directorStatus = normalized.status;
        delete normalized.status;
    }

    sceneDirectorState = {
        ...sceneDirectorState,
        ...normalized,
        directorUpdatedAt: new Date(),
    };
    refreshSceneDirectorPanel();
}

function recordBackstageIssue(source, message) {
    sceneDirectorState = {
        ...sceneDirectorState,
        persistentIssue: String(message ?? '').trim(),
        persistentIssueSource: String(source ?? '').trim(),
        persistentIssueAt: new Date(),
    };
    refreshSceneDirectorPanel();
}

function clearBackstageIssue() {
    sceneDirectorState = {
        ...sceneDirectorState,
        persistentIssue: '',
        persistentIssueSource: '',
        persistentIssueAt: null,
    };
    refreshSceneDirectorPanel();
}

function cloneDirectorRequestPayload(payload) {
    return JSON.parse(JSON.stringify(payload));
}

function getSceneDirectorMetadata(ctx = SillyTavern.getContext()) {
    ctx.chatMetadata.sceneDirector ??= {};
    return ctx.chatMetadata.sceneDirector;
}

function getStoryGuide(ctx = SillyTavern.getContext()) {
    return String(getSceneDirectorMetadata(ctx).storyGuide ?? '');
}

function saveStoryGuide(value, ctx = SillyTavern.getContext()) {
    const metadata = getSceneDirectorMetadata(ctx);
    metadata.storyGuide = String(value ?? '');
    metadata.storyGuideUpdatedAt = new Date().toISOString();
    ctx.saveMetadata?.();
}

function getPlannerUserTurnCounter(ctx = SillyTavern.getContext()) {
    return Math.max(0, Number(getSceneDirectorMetadata(ctx).userTurnsSincePlannerUpdate ?? 0));
}

function getStoryGuideUpdatedAt(ctx = SillyTavern.getContext()) {
    return String(getSceneDirectorMetadata(ctx).storyGuideUpdatedAt ?? '').trim();
}

function setPlannerUserTurnCounter(value, ctx = SillyTavern.getContext()) {
    const metadata = getSceneDirectorMetadata(ctx);
    metadata.userTurnsSincePlannerUpdate = Math.max(0, Number(value) || 0);
    ctx.saveMetadata?.();
    return metadata.userTurnsSincePlannerUpdate;
}

function incrementPlannerUserTurnCounter(ctx = SillyTavern.getContext()) {
    return setPlannerUserTurnCounter(getPlannerUserTurnCounter(ctx) + 1, ctx);
}

function stripMarkdownFence(text) {
    return String(text ?? '')
        .trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

async function getPlannerContextSnapshot(ctx = SillyTavern.getContext()) {
    const realMessages = (ctx.chat ?? []).filter(m =>
        !m.is_system &&
        m.extra?.type !== 'tool_call' &&
        m.extra?.type !== 'tool_response' &&
        m.mes != null &&
        !isBackstageOocMessage(m.mes)
    );
    const humanName = ctx.name1 || '';
    const sanitize = (text) => humanName ? String(text ?? '').replace(/{{user}}/gi, humanName) : String(text ?? '');
    const recentChat = realMessages
        .slice(-Math.max(config.contextMessages, 20))
        .map(m => `${m.name || 'Unknown'}: ${sanitize(m.mes || '')}`)
        .join('\n');
    const [worldContext, lorebookContext] = await Promise.all([
        getVectFoxRouterContext(ctx),
        getSelectedWorldInfoContext(ctx),
    ]);
    const lorebookCatalog = await getSelectedWorldInfoCatalog();

    return {
        humanName,
        recentChat,
        worldContext,
        lorebookContext,
        lorebookCatalog,
        currentGuide: getStoryGuide(ctx),
    };
}

async function getRouterContextSnapshot(chatHistory = null, ctx = SillyTavern.getContext()) {
    const sourceChat = Array.isArray(chatHistory) ? chatHistory : (ctx.chat ?? []);
    const realMessages = sourceChat.filter(m =>
        !m.is_system &&
        m.extra?.type !== 'tool_call' &&
        m.extra?.type !== 'tool_response' &&
        m.mes != null &&
        !isBackstageOocMessage(m.mes)
    );
    const lastSpeaker = realMessages[realMessages.length - 1]?.name || 'Unknown';
    const contextMessages = realMessages.slice(-config.contextMessages);
    const playerNames = config.characters.map(c => c.name).join(', ');
    const humanName = ctx.name1 || '';
    const sanitize = (text) => humanName ? String(text ?? '').replace(/{{user}}/gi, humanName) : String(text ?? '');
    const recentChat = contextMessages.map(m => `${m.name}: ${sanitize(m.mes || '')}`).join('\n');
    const storyGuide = getStoryGuide(ctx);
    const [worldContext, lorebookContext, lorebookCatalog] = await Promise.all([
        getVectFoxRouterContext(ctx),
        getSelectedWorldInfoContext(ctx),
        getSelectedWorldInfoCatalog(),
    ]);

    return {
        lastSpeaker,
        playerNames,
        humanName,
        recentChat,
        storyGuide,
        worldContext,
        lorebookContext,
        lorebookCatalog,
    };
}

async function updateStoryGuideFromContext(options = {}) {
    const source = String(options.source ?? 'manual');
    const showMissingProfileToast = options.showMissingProfileToast ?? (source !== 'auto');
    const showSuccessToast = options.showSuccessToast ?? (source !== 'auto');
    const showErrorToast = options.showErrorToast ?? true;
    const activateDirectorTab = options.activateDirectorTab ?? (source !== 'auto');
    const ctx = SillyTavern.getContext();
    if (!config.plannerProfileId) {
        if (showMissingProfileToast) {
            toastr.warning('Configure um perfil do Planner primeiro.', EXTENSION_LABEL);
        }
        return null;
    }

    if (isStoryGuideUpdateInProgress) {
        if (source === 'manual') {
            toastr.info('StoryGuide update already in progress.', EXTENSION_LABEL);
        }
        return null;
    }

    isStoryGuideUpdateInProgress = true;
    updateStoryDirectorState({
        status: 'updating-story-guide',
        ...(activateDirectorTab ? { activeTab: 'director' } : {}),
        directorView: 'workspace',
        plannerError: '',
        lastError: '',
    });

    const plannerContext = await getPlannerContextSnapshot(ctx);
    const plannerPrompt = renderTemplate(config.plannerPrompt || DEFAULT_STORY_PLANNER_PROMPT, {
        user: plannerContext.humanName,
    });

    const messages = [
        {
            role: 'system',
            content: plannerPrompt,
        },
        {
            role: 'user',
            content: `Current StoryGuide:
${plannerContext.currentGuide || '(empty)'}

Recent chat:
${plannerContext.recentChat || '(empty)'}

World context:
${plannerContext.worldContext.text || '(empty)'}

Selected lorebook context:
${plannerContext.lorebookContext.text || '(empty)'}

Selected lorebook catalog:
${plannerContext.lorebookCatalog.text || '(empty)'}

Last SceneDirector decision:
${JSON.stringify(sceneDirectorState.lastDecision ?? null, null, 2)}

Update the StoryGuide now.`,
        },
    ];

    try {
        updateStoryDirectorState({ lastPlannerPromptMessages: messages });
        const service = await getConnService();
        const response = await service.sendRequest(
            config.plannerProfileId,
            messages,
            undefined,
            { stream: false, extractData: true },
        );
        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? '';
        const responseText = extractResponseText(response);
        const updatedGuide = stripMarkdownFence(responseText);

        if (!updatedGuide) {
            recordBackstageIssue('Story Director', 'StoryGuide updater returned empty output.');
            updateStoryDirectorState({
                status: 'story-guide-empty-response',
                plannerReasoning: reasoning,
                plannerRawOutput: responseText,
                plannerError: 'StoryGuide updater returned empty output.',
                lastError: 'StoryGuide updater returned empty output.',
            });
            toastr.error('Updater retornou vazio.', EXTENSION_LABEL);
            return null;
        }

        saveStoryGuide(updatedGuide, ctx);
        setPlannerUserTurnCounter(0, ctx);
        clearBackstageIssue();
        updateStoryDirectorState({
            status: 'story-guide-updated',
            ...(activateDirectorTab ? { activeTab: 'director' } : {}),
            plannerReasoning: reasoning,
            plannerRawOutput: responseText,
            plannerError: '',
        });
        if (showSuccessToast) {
            toastr.success('StoryGuide atualizado.', EXTENSION_LABEL);
        }
        return updatedGuide;
    } catch (error) {
        console.error('[SceneDirector] Failed to update StoryGuide:', error);
        recordBackstageIssue('Story Director', error?.message ?? String(error));
        updateStoryDirectorState({
            status: 'error',
            plannerError: error?.message ?? String(error),
            lastError: error?.message ?? String(error),
        });
        if (showErrorToast) {
            toastr.error('Erro ao atualizar StoryGuide. Veja o console.', EXTENSION_LABEL);
        }
        return null;
    } finally {
        isStoryGuideUpdateInProgress = false;
    }
}

async function runPlannerOocRequest() {
    if (!config.plannerProfileId) {
        toastr.warning('Configure um perfil do Planner primeiro.', EXTENSION_LABEL);
        return null;
    }

    const oocRequest = String(sceneDirectorState.plannerOocDraft ?? '').trim();
    if (!oocRequest) {
        toastr.info('Escreva um request OOC para falar com o planner.', EXTENSION_LABEL);
        return null;
    }

    if (isStoryGuideUpdateInProgress) {
        toastr.info('Planner already running.', EXTENSION_LABEL);
        return null;
    }

    const ctx = SillyTavern.getContext();
    isStoryGuideUpdateInProgress = true;
    updateStoryDirectorState({
        status: 'planner-ooc-running',
        activeTab: 'director',
        directorView: 'workspace',
        plannerError: '',
        lastError: '',
    });

    try {
        const plannerContext = await getPlannerContextSnapshot(ctx);
        const plannerPrompt = renderTemplate(config.plannerPrompt || DEFAULT_STORY_PLANNER_PROMPT, {
            user: plannerContext.humanName,
        });
        const priorHistory = Array.isArray(sceneDirectorState.plannerOocHistory)
            ? sceneDirectorState.plannerOocHistory.slice(-12).map(message => ({
                role: message?.role === 'user' ? 'user' : 'assistant',
                content: String(message?.content ?? ''),
            }))
            : [];
        const messages = [
            {
                role: 'system',
                content: plannerPrompt,
            },
            {
                role: 'system',
                content: 'Planner workspace mode. Respond directly to the operator in OOC. Do not rewrite or replace the StoryGuide unless the operator explicitly asks for that. Do not narrate in-character prose.',
            },
            {
                role: 'system',
                content: `Current StoryGuide:
${plannerContext.currentGuide || '(empty)'}

Recent chat:
${plannerContext.recentChat || '(empty)'}

World context:
${plannerContext.worldContext.text || '(empty)'}

Selected lorebook context:
${plannerContext.lorebookContext.text || '(empty)'}

Selected lorebook catalog:
${plannerContext.lorebookCatalog.text || '(empty)'}

Last SceneDirector decision:
${JSON.stringify(sceneDirectorState.lastDecision ?? null, null, 2)}

Treat the messages that follow as an ongoing OOC conversation with the operator about this current RP state.`,
            },
            ...priorHistory,
            {
                role: 'user',
                content: oocRequest,
            },
        ];

        updateStoryDirectorState({ lastPlannerPromptMessages: messages });
        const service = await getConnService();
        const response = await service.sendRequest(
            config.plannerProfileId,
            messages,
            undefined,
            { stream: false, extractData: true },
        );
        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? '';
        const responseText = stripMarkdownFence(extractResponseText(response));

        if (!responseText) {
            recordBackstageIssue('Planner OOC', 'Planner workspace returned empty output.');
            updateStoryDirectorState({
                status: 'planner-ooc-empty-response',
                plannerReasoning: reasoning,
                plannerRawOutput: '',
                plannerError: 'Planner workspace returned empty output.',
                lastError: 'Planner workspace returned empty output.',
            });
            toastr.error('Planner retornou vazio.', EXTENSION_LABEL);
            return null;
        }

        const nextHistory = [
            ...(Array.isArray(sceneDirectorState.plannerOocHistory) ? sceneDirectorState.plannerOocHistory : []),
            { role: 'user', content: oocRequest },
            { role: 'assistant', content: responseText },
        ];

        updateStoryDirectorState({
            status: 'planner-ooc-ready',
            plannerReasoning: reasoning,
            plannerRawOutput: formatPlannerOocTranscript(nextHistory),
            plannerOocDraft: PLANNER_OOC_DEFAULT_DRAFT,
            plannerOocHistory: nextHistory,
            plannerError: '',
        });
        clearBackstageIssue();
        return responseText;
    } catch (error) {
        console.error('[SceneDirector] Failed to run planner workspace request:', error);
        recordBackstageIssue('Planner OOC', error?.message ?? String(error));
        updateStoryDirectorState({
            status: 'planner-ooc-error',
            plannerError: error?.message ?? String(error),
            lastError: error?.message ?? String(error),
        });
        toastr.error('Erro ao falar com o planner. Veja o console.', EXTENSION_LABEL);
        return null;
    } finally {
        isStoryGuideUpdateInProgress = false;
    }
}

async function runRouterOocRequest() {
    if (!config.routerProfileId) {
        toastr.warning('Configure um perfil do Router primeiro.', EXTENSION_LABEL);
        return null;
    }

    const oocRequest = String(sceneDirectorState.routerOocDraft ?? '').trim();
    if (!oocRequest) {
        toastr.info('Escreva um request OOC para falar com o router.', EXTENSION_LABEL);
        return null;
    }

    if (isProcessing) {
        toastr.info('Router already running.', EXTENSION_LABEL);
        return null;
    }

    const ctx = SillyTavern.getContext();
    updateRouterState({
        status: 'router-ooc-running',
        activeTab: 'router',
        routerView: 'workspace',
        lastError: '',
    });

    try {
        const routerContext = await getRouterContextSnapshot(ctx.chat, ctx);
        const priorHistory = Array.isArray(sceneDirectorState.routerOocHistory)
            ? sceneDirectorState.routerOocHistory.slice(-12).map(message => ({
                role: message?.role === 'user' ? 'user' : 'assistant',
                content: String(message?.content ?? ''),
            }))
            : [];
        const budgetedRequest = await fitRouterMessagesToInputBudget(
            config.routerProfileId,
            routerContext,
            currentContext => buildRouterMessages(currentContext, {
                mode: 'ooc',
                priorHistory,
                oocRequest,
            }),
        );
        const messages = budgetedRequest.messages;

        updateRouterState({ lastPromptMessages: messages });
        const service = await getConnService();
        const response = await service.sendRequest(
            config.routerProfileId,
            messages,
            undefined,
            { stream: false, extractData: true },
        );
        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? '';
        const responseText = stripMarkdownFence(extractResponseText(response));

        if (!responseText) {
            recordBackstageIssue('Router OOC', 'Router workspace returned empty output.');
            updateRouterState({
                status: 'router-ooc-empty-response',
                lastReasoning: reasoning,
                lastRawOutput: '',
                lastDecision: null,
                lastError: 'Router workspace returned empty output.',
            });
            toastr.error('Router retornou vazio.', EXTENSION_LABEL);
            return null;
        }

        const nextHistory = [
            ...(Array.isArray(sceneDirectorState.routerOocHistory) ? sceneDirectorState.routerOocHistory : []),
            { role: 'user', content: oocRequest },
            { role: 'assistant', content: responseText },
        ];

        updateRouterState({
            status: 'router-ooc-ready',
            lastReasoning: reasoning,
            lastRawOutput: formatOocTranscript(nextHistory),
            routerOocDraft: ROUTER_OOC_DEFAULT_DRAFT,
            routerOocHistory: nextHistory,
            lastDecision: sceneDirectorState.lastDecision,
            lastError: '',
        });
        clearBackstageIssue();
        return responseText;
    } catch (error) {
        console.error('[SceneDirector] Failed to run router workspace request:', error);
        recordBackstageIssue('Router OOC', error?.message ?? String(error));
        updateRouterState({
            status: 'router-ooc-error',
            lastError: error?.message ?? String(error),
        });
        toastr.error('Erro ao falar com o router. Veja o console.', EXTENSION_LABEL);
        return null;
    }
}

async function runDirectedCharacterOoc(targetName, oocText) {
    if (!config.enabled) {
        toastr.info('Backstage is disabled.', EXTENSION_LABEL);
        return false;
    }

    if (isProcessing) {
        toastr.info('Another generation is already running.', EXTENSION_LABEL);
        return false;
    }

    const resolvedTarget = resolveRequestedCharacterName(targetName);
    if (!resolvedTarget || resolvedTarget === 'USER') {
        toastr.warning('Target OOC must be a character or GM, not USER.', EXTENSION_LABEL);
        return false;
    }

    const clean = resolvedTarget.toLowerCase().trim();
    const char = (config.characters ?? []).find(c => {
        const name = String(c?.name ?? '').toLowerCase().trim();
        return name === clean || name.includes(clean) || clean.includes(name);
    });

    if (!char) {
        toastr.warning(`Character not found for OOC target: ${resolvedTarget}`, EXTENSION_LABEL);
        return false;
    }

    isProcessing = true;
    skipNextCharacterAutoRouter = true;
    updateRouterState({
        status: 'direct-ooc',
        lastDecision: {
            nextSpeaker: char.name,
            reason: 'Directed OOC request',
            direction: '',
            scenePressure: '',
            avoid: '',
            raw: '',
            parsed: null,
        },
        lastError: '',
    });
    lockChat();

    try {
        await triggerChar(char, null, { directOocText: oocText });
        return true;
    } catch (error) {
        console.error('[SceneDirector] Failed direct OOC trigger:', error);
        recordBackstageIssue('Direct OOC', error?.message ?? String(error));
        skipNextCharacterAutoRouter = false;
        clearCharacterNote();
        clearStoryGuideInjection();
        clearLorebookInjection();
        clearDirectedOocPrompt();
        clearSceneDirection();
        isProcessing = false;
        unlockChat();
        updateRouterState({
            status: 'error',
            lastError: error?.message ?? String(error),
        });
        return false;
    }
}

async function handleUserTurnPipeline() {
    const ctx = SillyTavern.getContext();
    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
    const directedOoc = parseDirectedOocMessage(lastMsg?.mes);
    if (directedOoc) {
        await runDirectedCharacterOoc(directedOoc.target, directedOoc.request);
        return;
    }
    const userTurnsSincePlannerUpdate = incrementPlannerUserTurnCounter(ctx);
    const plannerInterval = Math.max(1, Number(config.plannerUserTurnInterval || DEFAULT_CONFIG.plannerUserTurnInterval));
    const shouldAutoUpdateStoryGuide = !!config.plannerProfileId && userTurnsSincePlannerUpdate >= plannerInterval;

    if (shouldAutoUpdateStoryGuide) {
        console.log('[Backstage] Auto-updating StoryGuide before router run', {
            userTurnsSincePlannerUpdate,
            plannerInterval,
        });

        await updateStoryGuideFromContext({
            source: 'auto',
            showMissingProfileToast: false,
            showSuccessToast: false,
            showErrorToast: true,
            activateDirectorTab: false,
        });
    }

    await runRouter('USER_MESSAGE_RENDERED');
}

async function callRouterAgent(chatHistory) {
    if (!config.enabled || !config.routerProfileId) {
        forcedRouterSpeaker = null;
        return null;
    }

    const ctx = SillyTavern.getContext();
    const routerContext = await getRouterContextSnapshot(chatHistory, ctx);
    const contextSummary = {
        recentMessages: routerContext.recentChat ? routerContext.recentChat.split('\n').filter(Boolean).length : 0,
        worldContextSource: routerContext.worldContext.source,
        worldContextEntries: routerContext.worldContext.entryCount,
        worldContextOriginalLength: routerContext.worldContext.originalLength,
        worldContextLength: routerContext.worldContext.text.length,
        worldContextTruncated: !!routerContext.worldContext.truncated,
        lorebookContextLength: routerContext.lorebookContext?.text?.length ?? 0,
        lorebookCatalogEntries: routerContext.lorebookCatalog?.entryCount ?? 0,
        forcedSpeaker: forcedRouterSpeaker || '',
    };
    updateRouterState({
        status: 'building-context',
        lastContext: contextSummary,
        lastError: '',
    });
    const budgetedRequest = await fitRouterMessagesToInputBudget(
        config.routerProfileId,
        routerContext,
        currentContext => buildRouterMessages(currentContext, {
            mode: 'route',
            forcedSpeaker: forcedRouterSpeaker,
        }),
    );
    const messages = budgetedRequest.messages;
    contextSummary.inputTokenBudget = budgetedRequest.budget;
    contextSummary.inputTokens = budgetedRequest.inputTokens;
    contextSummary.inputTrimmed = budgetedRequest.trimmed;
    lastDirectorRequest = cloneDirectorRequestPayload({
        profileId: config.routerProfileId,
        inputTokenBudget: budgetedRequest.budget,
        inputTokens: budgetedRequest.inputTokens,
        options: { stream: false, extractData: true },
        messages,
    });
    if (window.MultiCaller) {
        window.MultiCaller.lastDirectorRequest = lastDirectorRequest;
    }
    updateRouterState({
        lastPromptMessages: lastDirectorRequest.messages,
    });

    try {
        console.log('[SceneDirector] Router context', contextSummary);
        updateRouterState({ status: 'calling-director' });

        const service  = await getConnService();
        const response = await service.sendRequest(
            lastDirectorRequest.profileId,
            lastDirectorRequest.messages,
            undefined,
            lastDirectorRequest.options,
        );

        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? null;
        if (reasoning) console.log('[SceneDirector] Reasoning:', reasoning);

        const responseText = extractResponseText(response);
        if (!responseText) {
            console.warn('[SceneDirector] Formato de resposta desconhecido:', response);
            recordBackstageIssue('Router', 'Resposta vazia ou formato desconhecido.');
            updateRouterState({
                status: 'empty-response',
                lastReasoning: reasoning ?? '',
                lastRawOutput: '',
                lastDecision: null,
                lastError: 'Resposta vazia ou formato desconhecido.',
            });
            return null;
        }

        const decision = parseSceneDirectorDecision(responseText);
        console.log('[SceneDirector] Decision', decision);
        updateRouterState({
            status: decision.nextSpeaker ? 'decision-ready' : 'no-decision',
            lastReasoning: reasoning ?? '',
            lastRawOutput: responseText,
            lastDecision: decision,
            lastError: '',
        });
        clearBackstageIssue();

        return decision.nextSpeaker ? decision : null;

    } catch (error) {
        console.error('[SceneDirector] Erro no sendRequest:', error);
        recordBackstageIssue('Router', error?.message ?? String(error));
        updateRouterState({
            status: 'error',
            lastError: error?.message ?? String(error),
        });
        return null;
    } finally {
        forcedRouterSpeaker = null;
    }
}

// ================= TRIGGER =================


async function triggerChar(char, decision = null, options = {}) {
    fl('→ START', 'triggerChar', `char=${char.name} | last=${lastActiveChar} | profile=${char.profileName}`);
    let ctx = SillyTavern.getContext();
    const targetProfile = resolveCharacterProfileForSwitch(char, ctx);
    const previousChatLength = Array.isArray(ctx.chat) ? ctx.chat.length : 0;

    if (char.name !== lastActiveChar && targetProfile.profileName) {
        lastActiveChar = char.name;
        if (targetProfile.source === 'profileId' && targetProfile.profileName !== char.profileName) {
            char.profileName = targetProfile.profileName;
            saveConfig();
        }
        fl('  →', 'triggerChar', `/profile await=true "${targetProfile.profileName}" | source=${targetProfile.source}${targetProfile.profileId ? ` | id=${targetProfile.profileId}` : ''}`);
        await ctx.executeSlashCommandsWithOptions(`/profile await=true "${targetProfile.profileName}"`);
        ctx = SillyTavern.getContext();
        let recovered = await waitForChatRecovery(ctx, previousChatLength);
        let recoveredByReload = false;

        if (!recovered && previousChatLength > 0 && typeof ctx.reloadCurrentChat === 'function') {
            console.warn('[Backstage] Chat still empty after profile switch; forcing reloadCurrentChat before trigger', {
                char: char.name,
                profileName: targetProfile.profileName,
                previousChatLength,
                currentChatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
            });
            await ctx.reloadCurrentChat();
            ctx = SillyTavern.getContext();
            recovered = await waitForChatRecovery(ctx, previousChatLength, 4000);
            recoveredByReload = recovered;
        }

        fl('  ←', 'triggerChar', `profile switch done | chatRecovered=${recovered} | recoveredByReload=${recoveredByReload} | chatLength=${Array.isArray(ctx.chat) ? ctx.chat.length : 0}`);
        if (!recovered) {
            console.warn('[Backstage] Chat did not recover after profile switch before trigger', {
                char: char.name,
                profileName: targetProfile.profileName,
                previousChatLength,
                currentChatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
            });
        }
    } else {
        lastActiveChar = char.name;
    }

    setCharacterNote(char.name);
    applyStoryGuideInjectionForCharacter(char.name);
    await applyLorebookInjectionForCharacter(char.name);
    setDirectedOocPrompt(char.name, options.directOocText);
    clearSceneDirection();

    fl('  ✓', 'triggerChar', 'direction aplicada — aguardando settle final de 250ms');
    await new Promise(r => setTimeout(r, 250));

    const currentChat = Array.isArray(ctx.chat) ? ctx.chat : [];
    console.log('[Backstage] triggerChar pre-trigger chat snapshot', {
        char: char.name,
        chatLength: currentChat.length,
        lastMessages: currentChat.slice(-3).map(message => ({
            name: message?.name,
            is_user: !!message?.is_user,
            is_system: !!message?.is_system,
            type: message?.extra?.type ?? '',
            mesStart: String(message?.mes ?? '').slice(0, 120),
        })),
    });

    fl('  →', 'triggerChar', `/trigger "${char.name}"`);
    ctx.executeSlashCommandsWithOptions(`/trigger "${char.name}"`);
    fl('← END', 'triggerChar', `char=${char.name}`);
}

// ================= EXECUÇÃO =================

async function executeDecision(decision, caller = 'unknown') {
    const nextSpeaker = typeof decision === 'string' ? decision : decision?.nextSpeaker;
    const direction = typeof decision === 'object' ? decision?.direction : '';
    const scenePressure = typeof decision === 'object' ? decision?.scenePressure : '';
    const avoid = typeof decision === 'object' ? decision?.avoid : '';

    fl('→ START', 'executeDecision', `caller=${caller} | nextSpeaker="${nextSpeaker}"`);
    if (direction || scenePressure || avoid) {
        console.log('[SceneDirector] Direction for next turn', {
            nextSpeaker,
            reason: decision?.reason ?? '',
            direction,
            scenePressure,
            avoid,
        });
    }
    updateRouterState({
        status: 'executing',
        lastDecision: typeof decision === 'string'
            ? { nextSpeaker: decision, reason: '', direction: '', scenePressure: '', avoid: '', raw: decision, parsed: null }
            : decision,
    });

    const ctx = SillyTavern.getContext();
    const clean = String(nextSpeaker ?? '').trim().toLowerCase();

    if (!clean || clean === 'user' || clean === 'player' || clean === String(ctx.name1 ?? '').trim().toLowerCase()) {
        clearSceneDirection();
        clearStoryGuideInjection();
        clearLorebookInjection();
        clearDirectedOocPrompt();
        clearCharacterNote();
        fl('← END', 'executeDecision', `jogador | nextSpeaker="${nextSpeaker}"`);
        isProcessing = false;
        updateRouterState({ status: 'player-turn' });
        unlockChat();
        playUserSound();
        return;
    }

    const char = config.characters.find(c => {
        const name = c.name.toLowerCase().trim();
        return name === clean || name.includes(clean) || clean.includes(name);
    });

    if (!char) {
        clearSceneDirection();
        clearStoryGuideInjection();
        clearLorebookInjection();
        clearDirectedOocPrompt();
        clearCharacterNote();
        fl('← END', 'executeDecision', `jogador | nextSpeaker="${nextSpeaker}"`);
        isProcessing = false;
        updateRouterState({ status: 'player-turn' });
        unlockChat();
        playUserSound();
        return;
    }

    lockChat();
    await triggerChar(char, decision);

    fl('← END', 'executeDecision', `char=${char.name}`);
    // isProcessing fica true — só libera via GENERATION_ENDED
}

async function runRouter(triggerEvent = 'unknown') {
    if (isProcessing) {
        forcedRouterSpeaker = null;
        if (triggerEvent === 'CHARACTER_MESSAGE_RENDERED') {
            pendingAutoRouter = true;
        }
        fl('  =', 'runRouter', `bloqueado | isProcessing=true | trigger=${triggerEvent}`);
        updateRouterState({ status: 'blocked-processing' });
        return;
    }
    pendingAutoRouter = false;
    isProcessing = true;
    fl('→ START', 'runRouter', `trigger=${triggerEvent}`);
    updateRouterState({ status: 'running', lastError: '' });

    try {
        const ctx      = SillyTavern.getContext();
        const decision = await callRouterAgent(ctx.chat);
        if (decision) {
            await executeDecision(decision, 'runRouter');
        } else {
            fl('← END', 'runRouter', 'sem decisão');
            isProcessing = false;
            updateRouterState({ status: 'no-decision' });
        }
    } catch (e) {
        console.error('[SceneDirector] Erro no router:', e);
        fl('← END', 'runRouter', `erro: ${e.message}`);
        isProcessing = false;
        recordBackstageIssue('Router', e?.message ?? String(e));
        updateRouterState({
            status: 'error',
            lastError: e?.message ?? String(e),
        });
    }
}

// ================= UI =================

function formatPanelTime(value) {
    if (!value) return 'never';
    return value.toLocaleTimeString();
}

function formatStateLabel(value) {
    const normalized = String(value ?? 'idle').trim();
    if (!normalized) return 'idle';

    return normalized
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function getStatusTone(value) {
    const normalized = String(value ?? '').toLowerCase();
    if (!normalized || normalized === 'idle') return 'idle';
    if (normalized.includes('error') || normalized.includes('empty')) return 'danger';
    if (normalized.includes('blocked') || normalized.includes('warning')) return 'warning';
    if (
        normalized.includes('running')
        || normalized.includes('calling')
        || normalized.includes('building')
        || normalized.includes('executing')
        || normalized.includes('updating')
    ) {
        return 'info';
    }
    if (
        normalized.includes('ready')
        || normalized.includes('updated')
        || normalized.includes('decision')
    ) {
        return 'success';
    }
    return 'idle';
}

function renderStatusBadge(value) {
    const tone = getStatusTone(value);
    return `<span class="sd-status-badge sd-status-badge--${tone}">${escapeHtml(formatStateLabel(value))}</span>`;
}

function renderPersistentIssueBanner() {
    const message = String(sceneDirectorState.persistentIssue ?? '').trim();
    if (!message) return '';

    const source = String(sceneDirectorState.persistentIssueSource ?? '').trim();
    const when = sceneDirectorState.persistentIssueAt ? formatPanelTime(new Date(sceneDirectorState.persistentIssueAt)) : 'unknown';

    return `
        <div class="sd-issue-banner">
            <div class="sd-issue-copy">
                <div class="sd-issue-title">Last API Issue${source ? ` - ${escapeHtml(source)}` : ''}</div>
                <div class="sd-issue-text">${escapeHtml(message)}</div>
                <div class="sd-issue-meta">Recorded ${escapeHtml(when)}</div>
            </div>
            <button id="scene-director-clear-issue" class="menu_button">Clear</button>
        </div>
    `;
}

function isActiveStatus(value) {
    const normalized = String(value ?? '').toLowerCase();
    return [
        'running',
        'building-context',
        'calling-director',
        'executing',
        'direct-ooc',
        'blocked-processing',
        'router-ooc-running',
        'updating-story-guide',
        'planner-ooc-running',
    ].includes(normalized);
}

function getTogglePipelineStatus() {
    const directorStatus = String(sceneDirectorState.directorStatus ?? '').toLowerCase();
    if (isActiveStatus(directorStatus)) {
        return 'Director';
    }

    const routerStatus = String(sceneDirectorState.routerStatus ?? '').toLowerCase();
    if (routerStatus === 'player-turn') {
        return 'Your turn';
    }

    if (routerStatus === 'executing' && isProcessing) {
        const nextSpeaker = String(sceneDirectorState.lastDecision?.nextSpeaker ?? '').trim();
        if (!nextSpeaker) return lastActiveChar || 'Executing';

        const lowered = nextSpeaker.toLowerCase();
        const playerNames = [
            'user',
            'player',
            String(SillyTavern.getContext()?.name1 ?? '').trim().toLowerCase(),
        ].filter(Boolean);

        return playerNames.includes(lowered) ? 'Your turn' : nextSpeaker;
    }

    if (routerStatus === 'calling-director') return 'Router';
    if (routerStatus === 'building-context' || routerStatus === 'running') return 'Routing';
    if (routerStatus === 'blocked-processing') return lastActiveChar || 'Busy';

    if (isProcessing && lastActiveChar) {
        return lastActiveChar;
    }

    if (String(sceneDirectorState.persistentIssue ?? '').trim()) {
        return 'Error';
    }

    return 'Idle';
}

function renderStatCard(label, value, note = '') {
    return `
        <div class="sd-stat-card">
            <div class="sd-stat-label">${escapeHtml(label)}</div>
            <div class="sd-stat-value">${escapeHtml(value)}</div>
            ${note ? `<div class="sd-stat-note">${escapeHtml(note)}</div>` : ''}
        </div>
    `;
}

function renderCard(title, subtitle, body, options = {}) {
    const extraClass = options.extraClass ? ` ${options.extraClass}` : '';
    const actions = options.actions ? `<div class="sd-card-actions">${options.actions}</div>` : '';

    return `
        <section class="sd-card${extraClass}">
            <div class="sd-card-head">
                <div>
                    <div class="sd-card-title">${escapeHtml(title)}</div>
                    ${subtitle ? `<div class="sd-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
                </div>
                ${actions}
            </div>
            <div class="sd-card-body">
                ${body}
            </div>
        </section>
    `;
}

function renderDisclosure(title, subtitle, body, options = {}) {
    const open = options.open ? ' open' : '';
    const extraClass = options.extraClass ? ` ${options.extraClass}` : '';

    return `
        <details class="sd-disclosure${extraClass}"${open}>
            <summary class="sd-disclosure-summary">
                <div>
                    <div class="sd-disclosure-title">${escapeHtml(title)}</div>
                    ${subtitle ? `<div class="sd-disclosure-subtitle">${escapeHtml(subtitle)}</div>` : ''}
                </div>
                <span class="sd-disclosure-icon">+</span>
            </summary>
            <div class="sd-disclosure-body">
                ${body}
            </div>
        </details>
    `;
}

function formatOocTranscript(history = []) {
    const items = Array.isArray(history) ? history : [];
    if (!items.length) return '';

    return [...items]
        .reverse()
        .map((message, index) => {
            const role = String(message?.role ?? 'assistant').trim().toUpperCase();
            const content = String(message?.content ?? '').trim();
            return `# ${index + 1} ${role}\n${content || '(empty)'}`;
        })
        .join('\n\n');
}

function formatPlannerOocTranscript(history = []) {
    return formatOocTranscript(history);
}

function getPlannerWorkspaceResponseText() {
    const transcript = formatPlannerOocTranscript(sceneDirectorState.plannerOocHistory);
    return transcript || String(sceneDirectorState.plannerRawOutput ?? '');
}

function getRouterWorkspaceResponseText() {
    const transcript = formatOocTranscript(sceneDirectorState.routerOocHistory);
    return transcript || String(sceneDirectorState.lastRawOutput ?? '');
}

function renderDecisionSummary(decision) {
    if (!decision) {
        return '<div class="sd-muted">No decision yet.</div>';
    }

    return `
        <div class="sd-kv"><span>nextSpeaker</span><b>${escapeHtml(decision.nextSpeaker || '')}</b></div>
        <div class="sd-kv"><span>parsed</span><b>${decision.parsed ? 'true' : 'false'}</b></div>
        <label>Reason</label>
        <pre>${escapeHtml(decision.reason || '')}</pre>
        <label>Direction</label>
        <pre>${escapeHtml(decision.direction || '')}</pre>
        <label>Pressure</label>
        <pre>${escapeHtml(decision.scenePressure || '')}</pre>
        <label>Avoid</label>
        <pre>${escapeHtml(decision.avoid || '')}</pre>
    `;
}

function renderContextSummary(context) {
    if (!context) {
        return '<div class="sd-muted">No context built yet.</div>';
    }

    return `
        <div class="sd-kv"><span>recentMessages</span><b>${escapeHtml(context.recentMessages)}</b></div>
        <div class="sd-kv"><span>VectFox entries</span><b>${escapeHtml(context.worldContextEntries)}</b></div>
        <div class="sd-kv"><span>world length</span><b>${escapeHtml(context.worldContextLength)}</b></div>
        <div class="sd-kv"><span>original length</span><b>${escapeHtml(context.worldContextOriginalLength)}</b></div>
        <div class="sd-kv"><span>truncated</span><b>${context.worldContextTruncated ? 'true' : 'false'}</b></div>
        <div class="sd-kv"><span>input budget</span><b>${escapeHtml(context.inputTokenBudget ?? 0)}</b></div>
        <div class="sd-kv"><span>input tokens</span><b>${escapeHtml(context.inputTokens ?? 0)}</b></div>
        <div class="sd-kv"><span>budget trim</span><b>${context.inputTrimmed ? 'true' : 'false'}</b></div>
        <div class="sd-source">${escapeHtml(context.worldContextSource || '')}</div>
    `;
}

function formatPromptMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) {
        return 'No captured request yet.';
    }

    return messages
        .map((message, index) => {
            const role = String(message?.role ?? 'unknown').toUpperCase();
            const content = String(message?.content ?? '').trim();
            return `# ${index + 1} ${role}\n${content || '(empty)'}`;
        })
        .join('\n\n');
}

function renderRouterInjectionPreview(decision) {
    if (!decision) {
        return '<div class="sd-muted">No router decision yet.</div>';
    }

    const targetName = resolveDecisionCharacterName(decision);
    if (!targetName || targetName === 'USER') {
        return '<div class="sd-muted">No character injection for player turns.</div>';
    }

    const prompt = buildSceneDirectionPrompt(decision, targetName);
    if (!prompt) {
        return `<div class="sd-muted">No scene directive generated for ${escapeHtml(targetName)}.</div>`;
    }

    return `
        <div class="sd-kv"><span>Target</span><b>${escapeHtml(targetName)}</b></div>
        <pre class="sd-console sd-console--tall">${escapeHtml(prompt)}</pre>
    `;
}

function renderRouterTimedLorebookStatus() {
    const timedConfig = getRouterTimedLorebookConfig();
    const regex = tryBuildRouterTimedLorebookRegex();
    const entry = getRouterTimedLorebookCachedEntry();
    const effectMode = getRouterTimedLorebookEffectMode(entry);

    if (!timedConfig.book || !Number.isFinite(timedConfig.uid) || timedConfig.uid <= 0) {
        return '<div class="sd-muted">No trigger target selected.</div>';
    }

    return `
        <div class="sd-kv"><span>Entry</span><b>${escapeHtml(timedConfig.name || `UID ${timedConfig.uid}`)}</b></div>
        <div class="sd-kv"><span>Book</span><b>${escapeHtml(timedConfig.book)}</b></div>
        <div class="sd-kv"><span>Regex</span><b>${escapeHtml(timedConfig.triggerRegex || '(empty)')}</b></div>
        <div class="sd-kv"><span>Regex valid</span><b>${regex ? 'yes' : 'no'}</b></div>
        <div class="sd-kv"><span>Trigger effect</span><b>${escapeHtml(effectMode || 'none')}</b></div>
        <div class="sd-kv"><span>Entry sticky</span><b>${escapeHtml(String(Number(entry?.sticky) || 0))}</b></div>
        <div class="sd-kv"><span>Entry cooldown</span><b>${escapeHtml(String(Number(entry?.cooldown) || 0))}</b></div>
    `;
}

function renderWorkspaceNav() {
    const items = [
        {
            key: 'router',
            title: ROUTER_LABEL,
            copy: 'Choose the next speaker, inspect context and validate routing output.',
        },
        {
            key: 'director',
            title: STORY_DIRECTOR_LABEL,
            copy: 'Maintain the private StoryGuide, planner prompt and lorebook scope.',
        },
    ];

    return `
        <aside class="sd-sidebar">
            <div class="sd-sidebar-title">${escapeHtml(EXTENSION_DISPLAY_NAME)}</div>
            <div class="sd-sidebar-copy">One control room for turn routing and private story planning.</div>
            <div class="sd-stage-nav">
                ${items.map(item => `
                    <button class="sd-stage-link ${sceneDirectorState.activeTab === item.key ? 'sd-stage-link--active' : ''}" data-stage="${item.key}">
                        <span class="sd-stage-name">${escapeHtml(item.title)}</span>
                        <span class="sd-stage-copy">${escapeHtml(item.copy)}</span>
                    </button>
                `).join('')}
            </div>
        </aside>
    `;
}

function renderRouterWorkspacePanel(capturedPrompt) {
    const routerResponseText = getRouterWorkspaceResponseText();
    return `
        <div class="sd-grid">
            ${renderDisclosure('Router OOC', 'Chamada direta e descartavel para conversar com o router fora do runtime normal.', `
                <textarea id="router-ooc-request" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(sceneDirectorState.routerOocDraft || ROUTER_OOC_DEFAULT_DRAFT)}</textarea>
                <div class="sd-inline-actions">
                    <button id="router-send-ooc" class="menu_button primary">Send OOC</button>
                    <button id="router-clear-ooc" class="menu_button">Clear Draft</button>
                </div>
                <div class="sd-footnote">Usa o perfil do router, envia o contexto atual e mostra a resposta na UI sem disparar personagens.</div>
            `, { open: true })}

            <div class="sd-grid sd-grid--double">
                ${renderCard('Latest Decision', 'Parsed result returned by the router.', renderDecisionSummary(sceneDirectorState.lastDecision))}
                ${renderCard('Context Snapshot', 'What the router used when building the request.', renderContextSummary(sceneDirectorState.lastContext))}
            </div>

            ${renderCard('Router Injection', 'Preview of the private directive that will be injected into the selected character.', renderRouterInjectionPreview(sceneDirectorState.lastDecision))}

            ${renderDisclosure('Router Response', 'Resposta direta da ultima chamada OOC ao router ou da ultima execucao capturada.', `
                <pre class="sd-console sd-console--tall">${escapeHtml(routerResponseText || 'No router response yet.')}</pre>
                ${sceneDirectorState.lastError ? `<pre class="sd-console sd-console--error">${escapeHtml(sceneDirectorState.lastError)}</pre>` : ''}
            `)}

            ${renderDisclosure('Reasoning', 'Model-side reasoning extracted from the router call.', `
                <pre class="sd-console sd-console--tall">${escapeHtml(sceneDirectorState.lastReasoning || 'No reasoning returned yet.')}</pre>
            `)}

            ${renderDisclosure('Last Router Request', 'Useful when the turn result smells wrong and you want the exact payload.', `
                <pre class="sd-console sd-console--wide">${escapeHtml(capturedPrompt || 'No router request captured yet.')}</pre>
            `)}
        </div>
    `;
}

function renderRouterConfigPanel(castCount) {
    return `
        <div class="sd-grid sd-grid--double">
            ${renderCard('Router Settings', 'Connection and context shaping for the turn router.', `
                <label>Connection profile</label>
                <select id="router-profile-dropdown" class="text_pole"></select>

                <div class="sd-row">
                    <div>
                        <label>Context messages</label>
                        <input type="number" id="router-context" class="text_pole" min="1" max="50" value="${config.contextMessages}">
                    </div>
                    <div>
                        <label>Input token budget</label>
                        <input type="number" id="router-input-token-budget" class="text_pole" min="0" max="20000" step="100" value="${config.routerInputTokenBudget}">
                    </div>
                </div>

                <label>VectFox world context chars (0 = disabled)</label>
                <input type="number" id="router-world-context-chars" class="text_pole" min="0" max="30000" step="500" value="${config.worldContextChars}">
                <div class="sd-footnote">0 skips the VectFox dry-run entirely. Values above 0 call VectFox and cap the injected text by character count. Output tokens stay under the active connection profile.</div>

                <hr class="sysHR">

                <label>Trigger lorebook book</label>
                <select id="router-timed-lorebook-book" class="text_pole"></select>

                <label>Search entry</label>
                <input type="text" id="router-timed-lorebook-search" class="text_pole" placeholder="Type to filter entries from the selected lorebook" value="${escapeHtml(sceneDirectorState.routerTimedLorebookSearch || '')}">

                <label>Matched entries</label>
                <select id="router-timed-lorebook-results" class="text_pole" size="8"></select>
                <div id="router-timed-lorebook-selected" class="sd-footnote">${escapeHtml(config.routerTimedLorebookName || 'No entry selected.')}</div>

                <label>GM trigger regex</label>
                <input type="text" id="router-timed-lorebook-regex" class="text_pole" placeholder="Example: skill-check|\\[Check\\]|roll" value="${escapeHtml(config.routerTimedLorebookTriggerRegex || '')}">
                <div class="sd-footnote">When a GM message matches this regex, Backstage applies the ST timed effect to the selected entry. It prefers sticky if the entry has sticky configured; otherwise it uses cooldown.</div>
                ${renderRouterTimedLorebookStatus()}
            `)}
            ${renderCard('Cast Routing', 'Map each group member to a connection profile before triggering turns.', `
                <div class="sd-inline-actions">
                    <button id="router-load-group-btn" class="menu_button">Refresh Group Members</button>
                    <span class="sd-muted">Use this after changing the active group.</span>
                </div>
                <div id="router-group-members"></div>
                <div class="sd-footnote">${castCount ? `${castCount} tracked character slots loaded.` : 'No tracked character slots loaded yet.'}</div>
            `)}
        </div>
        ${renderCard('Router Prompt Template', 'Editable system prompt used by the turn router.', `
            <textarea id="router-prompt" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(config.routerPrompt)}</textarea>
            <div class="sd-footnote">Autosaves when focus leaves the field.</div>
        `)}
    `;
}

function renderRouterWorkspace() {
    const capturedPrompt = formatPromptMessages(sceneDirectorState.lastPromptMessages);
    const castCount = Array.isArray(config.characters) ? config.characters.length : 0;
    const routerView = sceneDirectorState.routerView === 'config' ? 'config' : 'workspace';

    return `
        <div class="sd-main">
            ${renderPersistentIssueBanner()}
            <section class="sd-hero sd-hero--router">
                <div>
                    <div class="sd-eyebrow">Backstage Module</div>
                    <h3>${escapeHtml(ROUTER_LABEL)}</h3>
                    <p>Run the turn selection loop, inspect the evidence and keep routing decisions readable.</p>
                </div>
                <div class="sd-hero-meta">
                    ${renderStatusBadge(sceneDirectorState.routerStatus)}
                    <div class="sd-hero-note">Updated ${escapeHtml(formatPanelTime(sceneDirectorState.routerUpdatedAt))}</div>
                </div>
            </section>

            <div class="sd-toolbar sd-toolbar--router">
                <button id="router-send-ooc-toolbar" class="menu_button primary">Send OOC</button>
                <button id="scene-director-run" class="menu_button primary">Run Router</button>
                <button id="scene-director-test-director" class="menu_button">Test Router</button>
                <button id="scene-director-test-vectfox" class="menu_button">Test VectFox</button>
                <button id="scene-director-copy-prompt" class="menu_button">Copy Last Request</button>
                <button id="scene-director-clear-router" class="menu_button">Clear Router Console</button>
            </div>

            <div class="sd-subnav">
                <button class="menu_button sd-subnav-button${routerView === 'workspace' ? ' sd-subnav-button--active' : ''}" data-router-view="workspace">Workspace</button>
                <button class="menu_button sd-subnav-button${routerView === 'config' ? ' sd-subnav-button--active' : ''}" data-router-view="config">Config</button>
            </div>

            <div class="sd-summary-grid">
                ${renderStatCard('Status', formatStateLabel(sceneDirectorState.routerStatus), 'Current router pipeline state')}
                ${renderStatCard('Updated', formatPanelTime(sceneDirectorState.routerUpdatedAt), 'Last router-related UI refresh')}
                ${renderStatCard('Tracked Cast', String(castCount), castCount ? 'Character profile slots loaded' : 'Load the group to map profiles')}
                ${renderStatCard('Captured Prompt', sceneDirectorState.lastPromptMessages?.length ? 'Yes' : 'No', 'Latest router request payload')}
            </div>

            ${routerView === 'config'
                ? renderRouterConfigPanel(castCount)
                : renderRouterWorkspacePanel(capturedPrompt)}
        </div>
    `;
}

function renderStoryDirectorWorkspacePanel(storyGuide, capturedPrompt) {
    const plannerResponseText = getPlannerWorkspaceResponseText();
    return `
        <div class="sd-grid">
            ${renderDisclosure('Planner OOC', 'Chamada direta e descartavel para conversar com o planner fora do fluxo do StoryGuide.', `
                <textarea id="planner-ooc-request" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(sceneDirectorState.plannerOocDraft || PLANNER_OOC_DEFAULT_DRAFT)}</textarea>
                <div class="sd-inline-actions">
                    <button id="planner-send-ooc" class="menu_button primary">Send OOC</button>
                    <button id="planner-clear-ooc" class="menu_button">Clear Draft</button>
                </div>
                <div class="sd-footnote">Usa o perfil do planner, envia o contexto atual, mostra a resposta na UI e nao grava nada no StoryGuide.</div>
            `, { open: true })}

            ${renderDisclosure('Planner Response', 'Resposta direta da ultima chamada ao planner ou do ultimo update do StoryGuide.', `
                <pre class="sd-console sd-console--tall">${escapeHtml(plannerResponseText || 'No planner response yet.')}</pre>
                ${sceneDirectorState.plannerError ? `<pre class="sd-console sd-console--error">${escapeHtml(sceneDirectorState.plannerError)}</pre>` : ''}
            `)}

            ${renderDisclosure('Planner Reasoning', 'Reasoning retornado pela ultima chamada do planner.', `
                <pre class="sd-console sd-console--tall">${escapeHtml(sceneDirectorState.plannerReasoning || 'No planner reasoning returned yet.')}</pre>
            `)}

            ${renderDisclosure('Last Planner Request', 'Payload exato enviado ao planner.', `
                <pre class="sd-console sd-console--wide">${escapeHtml(capturedPrompt || 'No planner request captured yet.')}</pre>
            `)}

            ${renderDisclosure('StoryGuide', 'Estado privado persistido em chat metadata para este chat.', `
                <textarea id="scene-director-story-guide" class="text_pole sd-editor-textarea sd-editor-textarea--tall" spellcheck="false">${escapeHtml(storyGuide)}</textarea>
                <div class="sd-footnote">Autosaves when focus leaves the field.</div>
            `)}
        </div>
    `;
}

function renderStoryDirectorConfigPanel(selectedCount, plannerTurnsSinceUpdate, turnsUntilAutoUpdate, storyGuideUpdatedAt) {
    return `
        <div class="sd-grid">
            ${renderCard('Director Settings', 'Connection profile, cadence and lorebook scope for StoryGuide updates.', `
                <label>Connection profile</label>
                <select id="planner-profile-dropdown" class="text_pole"></select>

                <label>User turns between planner updates</label>
                <input type="number" id="planner-user-turn-interval" class="text_pole" min="1" max="100" value="${config.plannerUserTurnInterval}">

                <label>Selected lorebooks for planner context</label>
                <div class="sd-inline-actions">
                    <button id="planner-world-info-all" class="menu_button">Select All</button>
                    <button id="planner-world-info-none" class="menu_button">Clear All</button>
                    <span id="planner-world-info-count" class="sd-muted">${selectedCount} selected</span>
                </div>
                <div id="planner-world-info-books" class="sd-checkbox-list"></div>

                <div class="sd-kv"><span>Stored in</span><b>chat_metadata.sceneDirector.storyGuide</b></div>
                <div class="sd-kv"><span>Turns since update</span><b>${escapeHtml(plannerTurnsSinceUpdate)}</b></div>
                <div class="sd-kv"><span>Next auto update in</span><b>${escapeHtml(turnsUntilAutoUpdate)}</b></div>
                <div class="sd-kv"><span>Last saved</span><b>${escapeHtml(storyGuideUpdatedAt)}</b></div>
                <div class="sd-footnote">Autosaves on blur or selection change.</div>
            `)}
            ${renderCard('Template', 'Editable system prompt used by the Story Director planner.', `
                <textarea id="planner-prompt" class="text_pole sd-editor-textarea sd-editor-textarea--tall" spellcheck="false">${escapeHtml(config.plannerPrompt)}</textarea>
                <div class="sd-footnote">Autosaves when focus leaves the field.</div>
            `)}
        </div>
    `;
}

function renderStoryDirectorWorkspace() {
    const storyGuide = getStoryGuide();
    const selectedCount = Array.isArray(config.plannerWorldInfoBooks) ? config.plannerWorldInfoBooks.length : 0;
    const capturedPrompt = formatPromptMessages(sceneDirectorState.lastPlannerPromptMessages);
    const plannerTurnsSinceUpdate = getPlannerUserTurnCounter();
    const plannerInterval = Math.max(1, Number(config.plannerUserTurnInterval || DEFAULT_CONFIG.plannerUserTurnInterval));
    const turnsUntilAutoUpdate = Math.max(0, plannerInterval - plannerTurnsSinceUpdate);
    const storyGuideUpdatedAtRaw = getStoryGuideUpdatedAt();
    const storyGuideUpdatedAt = storyGuideUpdatedAtRaw ? formatPanelTime(new Date(storyGuideUpdatedAtRaw)) : 'never';
    const directorView = sceneDirectorState.directorView === 'config' ? 'config' : 'workspace';

    return `
        <div class="sd-main">
            ${renderPersistentIssueBanner()}
            <section class="sd-hero sd-hero--director">
                <div>
                    <div class="sd-eyebrow">Backstage Module</div>
                    <h3>${escapeHtml(STORY_DIRECTOR_LABEL)}</h3>
                    <p>Maintain the private planning layer, update StoryGuide state and inspect the planner output without digging through tabs.</p>
                </div>
                <div class="sd-hero-meta">
                    ${renderStatusBadge(sceneDirectorState.directorStatus)}
                    <div class="sd-hero-note">Updated ${escapeHtml(formatPanelTime(sceneDirectorState.directorUpdatedAt))}</div>
                </div>
            </section>

            <div class="sd-toolbar sd-toolbar--director">
                <button id="planner-send-ooc-toolbar" class="menu_button primary">Send OOC</button>
                <button id="scene-director-update-story-guide" class="menu_button primary">Update StoryGuide</button>
                <button id="scene-director-copy-story-guide" class="menu_button">Copy StoryGuide</button>
                <button id="scene-director-clear-director" class="menu_button">Clear Director Console</button>
            </div>

            <div class="sd-subnav">
                <button class="menu_button sd-subnav-button${directorView === 'workspace' ? ' sd-subnav-button--active' : ''}" data-director-view="workspace">Workspace</button>
                <button class="menu_button sd-subnav-button${directorView === 'config' ? ' sd-subnav-button--active' : ''}" data-director-view="config">Config</button>
            </div>

            <div class="sd-summary-grid">
                ${renderStatCard('Status', formatStateLabel(sceneDirectorState.directorStatus), 'Planner pipeline state')}
                ${renderStatCard('Updated', formatPanelTime(sceneDirectorState.directorUpdatedAt), 'Last Story Director refresh')}
                ${renderStatCard('Lorebooks', String(selectedCount), selectedCount ? 'Selected for planner context' : 'No lorebooks selected')}
                ${renderStatCard('StoryGuide', storyGuide ? `${storyGuide.length} chars` : 'Empty', 'Stored in chat metadata')}
                ${renderStatCard('Turns Since Update', String(plannerTurnsSinceUpdate), 'Counts only user turns')}
                ${renderStatCard('Auto Update In', String(turnsUntilAutoUpdate), `Every ${plannerInterval} user turns`)}
                ${renderStatCard('Last StoryGuide Save', storyGuideUpdatedAt, 'Timestamp from chat metadata')}
            </div>

            ${directorView === 'config'
                ? renderStoryDirectorConfigPanel(selectedCount, plannerTurnsSinceUpdate, turnsUntilAutoUpdate, storyGuideUpdatedAt)
                : renderStoryDirectorWorkspacePanel(storyGuide, capturedPrompt)}
        </div>
    `;
}

async function renderSceneDirectorPanel() {
    if ($('#scene-director-floating-root').length) return;

    const response = await fetch('/scripts/extensions/third-party/MultiCaller/floating-panel.html');
    if (!response.ok) {
        throw new Error(`Failed to load floating-panel.html: ${response.status}`);
    }

    $('body').append(await response.text());
    refreshSceneDirectorPanel();
}

function refreshSceneDirectorPanel() {
    const panel = $('#scene-director-panel');
    const toggleStatusText = getTogglePipelineStatus();
    $('#scene-director-toggle-status')
        .text(toggleStatusText)
        .attr('title', sceneDirectorState.persistentIssue ? `${sceneDirectorState.persistentIssueSource || 'Issue'}: ${sceneDirectorState.persistentIssue}` : toggleStatusText);
    if (!panel.length) return;

    panel.toggleClass('sd-hidden', !sceneDirectorState.panelOpen);

    const body = $('#scene-director-panel-body');
    body.html(`
        <div class="sd-shell">
            ${renderWorkspaceNav()}
            ${sceneDirectorState.activeTab === 'director' ? renderStoryDirectorWorkspace() : renderRouterWorkspace()}
        </div>
    `);

    $('#scene-director-header-status').html(
        sceneDirectorState.activeTab === 'director'
            ? renderStatusBadge(sceneDirectorState.directorStatus)
            : renderStatusBadge(sceneDirectorState.routerStatus)
    );

    if (sceneDirectorState.activeTab === 'router') {
        if (sceneDirectorState.routerView === 'config') {
            initRouterProfileDropdown();
            initRouterTimedLorebookSelect();
            renderGroupMembers();
        }
    } else {
        if (sceneDirectorState.directorView === 'config') {
            initPlannerProfileDropdown();
            initPlannerWorldInfoSelect();
        }
    }
}

function startToggleStatusTicker() {
    if (window.__backstageToggleStatusInterval) {
        clearInterval(window.__backstageToggleStatusInterval);
    }

    window.__backstageToggleStatusInterval = window.setInterval(() => {
        const toggleStatusText = getTogglePipelineStatus();
        $('#scene-director-toggle-status')
            .text(toggleStatusText)
            .attr('title', sceneDirectorState.persistentIssue ? `${sceneDirectorState.persistentIssueSource || 'Issue'}: ${sceneDirectorState.persistentIssue}` : toggleStatusText);
    }, 400);
}

function formatDirectorPromptForCopy(request) {
    if (!request?.messages?.length) return '';

    return request.messages
        .map(message => String(message.content ?? ''))
        .join('\n\n');
}

async function copyDirectorPromptToClipboard() {
    const promptText = formatDirectorPromptForCopy(lastDirectorRequest);

    if (!promptText) {
        toastr.warning('No router request captured yet.', EXTENSION_LABEL);
        return;
    }

    try {
        await navigator.clipboard.writeText(promptText);
        toastr.success('Router request copied.', EXTENSION_LABEL);
    } catch (error) {
        console.error('[SceneDirector] Failed to copy prompt:', error);
        toastr.error('Could not copy the router request. See console.', EXTENSION_LABEL);
    }
}

function getSelectedPlannerWorldInfoBooks() {
    return $('#planner-world-info-books input[type="checkbox"]:checked')
        .map((_, input) => String($(input).val() || '').trim())
        .get()
        .filter(Boolean);
}

function updatePlannerWorldInfoCount() {
    const count = getSelectedPlannerWorldInfoBooks().length;
    $('#planner-world-info-count').text(`${count} selected`);
}

function preserveVisiblePanelDrafts() {
    const routerPrompt = $('#router-prompt');
    if (routerPrompt.length) {
        config.routerPrompt = routerPrompt.val();
    }

    const routerOoc = $('#router-ooc-request');
    if (routerOoc.length) {
        sceneDirectorState.routerOocDraft = String(routerOoc.val() ?? '');
    }

    const plannerPrompt = $('#planner-prompt');
    if (plannerPrompt.length) {
        config.plannerPrompt = plannerPrompt.val();
    }

    const storyGuide = $('#scene-director-story-guide');
    if (storyGuide.length) {
        saveStoryGuide(storyGuide.val());
    }

    const plannerOoc = $('#planner-ooc-request');
    if (plannerOoc.length) {
        sceneDirectorState.plannerOocDraft = String(plannerOoc.val() ?? '');
    }
}

function persistDirectorPanelFields() {
    const routerContext = $('#router-context');
    const routerInputTokenBudget = $('#router-input-token-budget');
    const routerWorldContextChars = $('#router-world-context-chars');
    const routerPrompt = $('#router-prompt');
    const timedBook = $('#router-timed-lorebook-book');
    const timedSearch = $('#router-timed-lorebook-search');
    const timedResults = $('#router-timed-lorebook-results');
    const timedRegex = $('#router-timed-lorebook-regex');

    if ($('#router-profile-dropdown').length) {
        config.routerProfileId = $('#router-profile-dropdown').val() || config.routerProfileId;
    }
    if (routerContext.length) {
        config.contextMessages = Math.max(1, parseInt(routerContext.val()) || DEFAULT_CONFIG.contextMessages);
    }
    if (routerInputTokenBudget.length) {
        config.routerInputTokenBudget = Math.max(0, parseInt(routerInputTokenBudget.val()) || 0);
    }
    if (routerWorldContextChars.length) {
        config.worldContextChars = Math.max(0, parseInt(routerWorldContextChars.val()) || DEFAULT_CONFIG.worldContextChars);
    }
    if (routerPrompt.length) {
        config.routerPrompt = routerPrompt.val();
    }
    if (timedBook.length) {
        config.routerTimedLorebookBook = String(timedBook.val() || '').trim();
    }
    if (timedSearch.length) {
        sceneDirectorState.routerTimedLorebookSearch = String(timedSearch.val() ?? '');
    }
    if (timedResults.length) {
        config.routerTimedLorebookUid = String(timedResults.val() || '').trim();
    }
    if (timedRegex.length) {
        config.routerTimedLorebookTriggerRegex = String(timedRegex.val() ?? '').trim();
    }
    if ($('#router-ooc-request').length) {
        sceneDirectorState.routerOocDraft = String($('#router-ooc-request').val() ?? '');
    }

    saveConfig();
}

function persistPlannerPanelFields() {
    if ($('#planner-profile-dropdown').length) {
        config.plannerProfileId = $('#planner-profile-dropdown').val() || config.plannerProfileId;
    }
    if ($('#planner-user-turn-interval').length) {
        config.plannerUserTurnInterval = Math.max(1, parseInt($('#planner-user-turn-interval').val()) || DEFAULT_CONFIG.plannerUserTurnInterval);
    }
    if ($('#planner-world-info-books').length) {
        config.plannerWorldInfoBooks = getSelectedPlannerWorldInfoBooks();
    }
    if ($('#planner-prompt').length) {
        config.plannerPrompt = $('#planner-prompt').val();
    }
    if ($('#scene-director-story-guide').length) {
        saveStoryGuide($('#scene-director-story-guide').val());
    }
    if ($('#planner-ooc-request').length) {
        sceneDirectorState.plannerOocDraft = String($('#planner-ooc-request').val() ?? '');
    }

    saveConfig();
}

function attachFloatingPanelEvents() {
    $('#scene-director-toggle').on('click', () => {
        updateSceneDirectorState({ panelOpen: !sceneDirectorState.panelOpen });
    });
    $('#scene-director-close').on('click', () => {
        updateSceneDirectorState({ panelOpen: false });
    });
    $('#scene-director-panel-body').on('click', '[data-stage]', function () {
        preserveVisiblePanelDrafts();
        updateSceneDirectorState({ activeTab: $(this).data('stage') || 'router' });
    });
    $('#scene-director-panel-body').on('click', '[data-router-view]', function () {
        preserveVisiblePanelDrafts();
        updateRouterState({ routerView: $(this).data('router-view') || 'workspace' });
    });
    $('#scene-director-panel-body').on('click', '[data-director-view]', function () {
        preserveVisiblePanelDrafts();
        updateStoryDirectorState({ directorView: $(this).data('director-view') || 'workspace' });
    });
    $('#scene-director-panel-body').on('click', '#scene-director-run', async () => {
        await runRouter('floating-panel');
    });
    $('#scene-director-panel-body').on('click', '#scene-director-test-director', async () => {
        const ctx = SillyTavern.getContext();
        toastr.info('Running router test...', EXTENSION_LABEL);
        const decision = await callRouterAgent(ctx.chat);
        const nextSpeaker = typeof decision === 'string' ? decision : decision?.nextSpeaker;
        toastr.info(nextSpeaker ? `Next speaker: ${nextSpeaker}` : 'No response returned.', EXTENSION_LABEL);
    });
    $('#scene-director-panel-body').on('click', '#scene-director-test-vectfox', async () => {
        await testVectFoxPrompt('floating-panel');
    });
    $('#scene-director-panel-body').on('click', '#scene-director-copy-prompt', async () => {
        await copyDirectorPromptToClipboard();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-clear-router', () => {
        updateRouterState({
            status: 'idle',
            lastContext: null,
            lastDecision: null,
            lastReasoning: '',
            lastRawOutput: '',
            lastPromptMessages: null,
            routerOocDraft: ROUTER_OOC_DEFAULT_DRAFT,
            routerOocHistory: [],
            lastError: '',
        });
        clearBackstageIssue();
    });
    $('#scene-director-panel-body').on('click', '#router-send-ooc, #router-send-ooc-toolbar', async () => {
        persistDirectorPanelFields();
        await runRouterOocRequest();
    });
    $('#scene-director-panel-body').on('click', '#router-clear-ooc', () => {
        sceneDirectorState.routerOocDraft = ROUTER_OOC_DEFAULT_DRAFT;
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-clear-director', () => {
        updateStoryDirectorState({
            status: 'idle',
            plannerReasoning: '',
            plannerRawOutput: '',
            plannerError: '',
            lastPlannerPromptMessages: null,
            plannerOocHistory: [],
            lastError: '',
        });
        clearBackstageIssue();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-clear-issue', () => {
        clearBackstageIssue();
    });
    $('#scene-director-panel-body').on('click', '#planner-send-ooc, #planner-send-ooc-toolbar', async () => {
        persistPlannerPanelFields();
        await runPlannerOocRequest();
    });
    $('#scene-director-panel-body').on('click', '#planner-clear-ooc', () => {
        sceneDirectorState.plannerOocDraft = PLANNER_OOC_DEFAULT_DRAFT;
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '#planner-world-info-books input[type="checkbox"]', () => {
        updatePlannerWorldInfoCount();
        persistPlannerPanelFields();
    });
    $('#scene-director-panel-body').on('click', '#planner-world-info-all', () => {
        $('#planner-world-info-books input[type="checkbox"]').prop('checked', true);
        updatePlannerWorldInfoCount();
        persistPlannerPanelFields();
    });
    $('#scene-director-panel-body').on('click', '#planner-world-info-none', () => {
        $('#planner-world-info-books input[type="checkbox"]').prop('checked', false);
        updatePlannerWorldInfoCount();
        persistPlannerPanelFields();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-update-story-guide', async () => {
        persistPlannerPanelFields();
        await updateStoryGuideFromContext();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-copy-story-guide', async () => {
        persistPlannerPanelFields();
        await navigator.clipboard.writeText(getStoryGuide());
        toastr.success('StoryGuide copiado.', EXTENSION_LABEL);
    });
    $('#scene-director-panel-body').on('focusout', '#router-context, #router-input-token-budget, #router-world-context-chars, #router-prompt', () => {
        persistDirectorPanelFields();
    });
    $('#scene-director-panel-body').on('change', '#router-context, #router-input-token-budget, #router-world-context-chars', () => {
        persistDirectorPanelFields();
    });
    $('#scene-director-panel-body').on('change', '#router-timed-lorebook-book', async () => {
        config.routerTimedLorebookBook = String($('#router-timed-lorebook-book').val() || '').trim();
        config.routerTimedLorebookUid = '';
        config.routerTimedLorebookName = '';
        routerTimedLorebookLastTriggerSignature = '';
        saveConfig();
        await renderRouterTimedLorebookResults();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('input', '#router-timed-lorebook-search', async () => {
        sceneDirectorState.routerTimedLorebookSearch = String($('#router-timed-lorebook-search').val() ?? '');
        await renderRouterTimedLorebookResults();
    });
    $('#scene-director-panel-body').on('change', '#router-timed-lorebook-results', async () => {
        const bookName = String($('#router-timed-lorebook-book').val() || config.routerTimedLorebookBook || '').trim();
        const selectedUid = String($('#router-timed-lorebook-results').val() || '').trim();
        config.routerTimedLorebookBook = bookName;
        config.routerTimedLorebookUid = selectedUid;
        config.routerTimedLorebookName = '';

        if (bookName && selectedUid) {
            const entries = await getRouterTimedLorebookEntries(bookName);
            const selectedEntry = entries.find(entry => String(entry.uid) === selectedUid);
            config.routerTimedLorebookName = selectedEntry?.label ?? '';
        }

        saveConfig();
        routerTimedLorebookLastTriggerSignature = '';
        await renderRouterTimedLorebookResults();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change focusout', '#router-timed-lorebook-regex', async () => {
        persistDirectorPanelFields();
        routerTimedLorebookLastTriggerSignature = '';
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('focusout', '#router-ooc-request', () => {
        persistDirectorPanelFields();
    });
    $('#scene-director-panel-body').on('input', '#router-ooc-request', () => {
        sceneDirectorState.routerOocDraft = String($('#router-ooc-request').val() ?? '');
    });
    $('#scene-director-panel-body').on('focusout', '#planner-user-turn-interval, #planner-prompt, #scene-director-story-guide', () => {
        persistPlannerPanelFields();
    });
    $('#scene-director-panel-body').on('change', '#planner-user-turn-interval', () => {
        persistPlannerPanelFields();
    });
    $('#scene-director-panel-body').on('focusout', '#planner-ooc-request', () => {
        persistPlannerPanelFields();
    });
    $('#scene-director-panel-body').on('input', '#planner-ooc-request', () => {
        sceneDirectorState.plannerOocDraft = String($('#planner-ooc-request').val() ?? '');
    });
    $('#scene-director-panel-body').on('change', '#planner-profile-dropdown', () => {
        persistPlannerPanelFields();
    });
}

function renderSettings() {
    const html = `
        <div id="multicaller-settings" class="extension-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>${EXTENSION_DISPLAY_NAME}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <div class="flex-container flex-column flex-gap5 margin-bot-10px">
                        <label class="checkbox flex-container">
                            <input type="checkbox" id="router-enabled" ${config.enabled ? 'checked' : ''}>
                            <span>${ROUTER_LABEL} enabled</span>
                        </label>
                        <small style="color:#888;">Use the floating ${EXTENSION_DISPLAY_NAME} panel to manage ${ROUTER_LABEL} and ${STORY_DIRECTOR_LABEL}.</small>
                    </div>
                </div>
            </div>
        </div>

        <style>
            #multicaller-settings .flex-container { display: flex; }
            #multicaller-settings .flex-column { flex-direction: column; }
            #multicaller-settings .flex-gap5 { gap: 5px; }
            #multicaller-settings .flex-gap10 { gap: 10px; }
            #multicaller-settings .flex1 { flex: 1; }
            #multicaller-settings .margin-bot-10px { margin-bottom: 10px; }
            #multicaller-settings .margin-top-10px { margin-top: 10px; }
            #multicaller-settings .justify-center { justify-content: center; }
            #multicaller-settings h4 { margin: 15px 0 10px 0; border-bottom: 1px solid #444; padding-bottom: 5px; }
            #multicaller-settings label { font-size: 0.9em; color: #ccc; }
            #multicaller-settings .primary { background: #2d7d46; }
            #multicaller-settings .primary:hover { background: #36a355; }
        </style>
    `;

    $('#extensions_settings').append(html);
}

function loadGroupMembers() {
    const ctx   = SillyTavern.getContext();
    const group = ctx.groups.find(g => g.id === ctx.groupId);
    const container = $('#router-group-members');

    if (!group) {
        if (container.length) {
            container.html('<small style="color:#888;">Nenhum grupo ativo.</small>');
        }
        return;
    }

    const groupNames = group.members
        .map(avatar => ctx.characters.find(c => c.avatar === avatar))
        .filter(Boolean)
        .map(c => c.name);

    const existing    = config.characters || [];
    config.characters = groupNames.map(name => {
        const saved = existing.find(c => c.name === name);
        return saved ?? { name, profileId: '', profileName: '' };
    });

    if (container.length) {
        renderGroupMembers();
    }
}

function renderGroupMembers() {
    const container = $('#router-group-members');
    if (!container.length) {
        return;
    }

    if (!config.characters.length) {
        container.html('<small style="color:#888;">Nenhum personagem carregado.</small>');
        return;
    }

    const html = config.characters.map((char, idx) => `
        <div class="char-config-block sd-character-row" data-name="${char.name}" data-idx="${idx}">
            <div class="sd-character-name">
                <b>${char.name}</b>
            </div>
            <label>Perfil de conexão</label>
            <select id="char-profile-${idx}" class="char-profile text_pole"></select>
        </div>
    `).join('');

    container.html(`<h4>Personagens</h4>${html}`);

    // Inicializa o dropdown de cada personagem após o HTML estar no DOM
    initCharProfileDropdowns();
}

async function initRouterProfileDropdown() {
    if (!$('#router-profile-dropdown').length) return;
    const service = await getConnService();
    service.handleDropdown(
        '#router-profile-dropdown',
        config.routerProfileId,
        (profile) => {
            config.routerProfileId = profile?.id ?? '';
            saveConfig();
        }
    );
}

async function initPlannerProfileDropdown() {
    if (!$('#planner-profile-dropdown').length) return;
    const service = await getConnService();
    service.handleDropdown(
        '#planner-profile-dropdown',
        config.plannerProfileId,
        (profile) => {
            config.plannerProfileId = profile?.id ?? '';
            saveConfig();
        }
    );
}

async function initPlannerWorldInfoSelect() {
    const container = $('#planner-world-info-books');
    if (!container.length) return;

    try {
        const wi = await getWorldInfoModule();
        const worldNames = getAvailableWorldInfoNames(wi);
        const selected = new Set(Array.isArray(config.plannerWorldInfoBooks) ? config.plannerWorldInfoBooks : []);
        const options = worldNames
            .map((name, index) => {
                const id = `planner-world-info-book-${index}`;
                return `<label class="sd-checkbox-row" for="${id}">
                    <input id="${id}" type="checkbox" value="${escapeHtml(name)}" ${selected.has(name) ? 'checked' : ''}>
                    <span>${escapeHtml(name)}</span>
                </label>`;
            })
            .join('');

        container.html(options || '<div class="sd-muted">No lorebooks found.</div>');
        updatePlannerWorldInfoCount();
    } catch (error) {
        console.warn('[SceneDirector] Failed to initialize planner World Info select:', error);
        container.html('<div class="sd-muted">Could not load lorebooks.</div>');
        updatePlannerWorldInfoCount();
    }
}

async function renderRouterTimedLorebookResults() {
    const results = $('#router-timed-lorebook-results');
    const selectedSummary = $('#router-timed-lorebook-selected');
    if (!results.length || !selectedSummary.length) return;

    const bookName = String($('#router-timed-lorebook-book').val() || config.routerTimedLorebookBook || '').trim();
    const search = String($('#router-timed-lorebook-search').val() ?? sceneDirectorState.routerTimedLorebookSearch ?? '').trim().toLowerCase();
    sceneDirectorState.routerTimedLorebookSearch = String($('#router-timed-lorebook-search').val() ?? sceneDirectorState.routerTimedLorebookSearch ?? '');

    if (!bookName) {
        results.html('');
        selectedSummary.text('Select a lorebook first.');
        return;
    }

    try {
        const entries = await getRouterTimedLorebookEntries(bookName);
        const filtered = entries.filter(entry => !search || entry.searchText.includes(search));
        const selectedUid = Number(config.routerTimedLorebookUid);
        const visible = filtered.slice(0, 60);
        const selectedEntry = entries.find(entry => entry.uid === selectedUid) ?? null;

        results.html(visible.map(entry => `
            <option value="${escapeHtml(String(entry.uid))}" ${entry.uid === selectedUid ? 'selected' : ''}>
                ${escapeHtml(`${entry.label} | uid ${entry.uid}${entry.keys ? ` | ${entry.keys}` : ''}`)}
            </option>
        `).join(''));

        if (!visible.length) {
            results.html('<option value="">No matching entries.</option>');
        }

        selectedSummary.text(selectedEntry
            ? `${selectedEntry.label} | uid ${selectedEntry.uid}${selectedEntry.disable ? ' | currently disabled' : ''}${selectedEntry.sticky ? ` | sticky ${selectedEntry.sticky}` : ''}${selectedEntry.cooldown ? ` | cooldown ${selectedEntry.cooldown}` : ''}`
            : 'No entry selected.');
    } catch (error) {
        console.warn('[SceneDirector] Failed to render timed lorebook results:', error);
        results.html('<option value="">Could not load entries.</option>');
        selectedSummary.text('Could not load entries.');
    }
}

async function initRouterTimedLorebookSelect() {
    const select = $('#router-timed-lorebook-book');
    if (!select.length) return;

    try {
        const wi = await getWorldInfoModule();
        const worldNames = getAvailableWorldInfoNames(wi);
        const selectedBook = String(config.routerTimedLorebookBook ?? '').trim();
        const options = ['<option value="">-- none --</option>']
            .concat(worldNames.map(name => `<option value="${escapeHtml(name)}" ${name === selectedBook ? 'selected' : ''}>${escapeHtml(name)}</option>`));
        select.html(options.join(''));
        await renderRouterTimedLorebookResults();
    } catch (error) {
        console.warn('[SceneDirector] Failed to initialize timed lorebook select:', error);
        select.html('<option value="">Could not load lorebooks.</option>');
    }
}

async function initCharProfileDropdowns() {
    if (!$('#router-group-members').length) return;
    const service = await getConnService();
    config.characters.forEach((char, idx) => {
        if (!$(`#char-profile-${idx}`).length) {
            return;
        }
        service.handleDropdown(
            `#char-profile-${idx}`,
            char.profileId,
            (profile) => {
                config.characters[idx].profileId   = profile?.id   ?? '';
                config.characters[idx].profileName = profile?.name ?? '';
                saveConfig();
            }
        );
    });
}

function attachEvents() {
    $('#extensions_settings').on('change', '#router-enabled', () => {
        config.enabled = $('#router-enabled').is(':checked');
        saveConfig();
        toastr.success(config.enabled ? `${ROUTER_LABEL} enabled.` : `${ROUTER_LABEL} disabled.`, EXTENSION_LABEL);
    });

    $('#scene-director-panel-body').on('click', '#router-load-group-btn', () => loadGroupMembers());
}

// ================= MAIN =================

jQuery(document).ready(async () => {
    loadConfig();
    renderSettings();
    await renderSceneDirectorPanel();
    attachEvents();
    attachFloatingPanelEvents();
    startToggleStatusTicker();

    const ctx = SillyTavern.getContext();

    ctx.registerSlashCommand?.('router', async (_args, value) => {
        const requestedSpeaker = String(value ?? '').trim();
        if (requestedSpeaker) {
            forcedRouterSpeaker = resolveRequestedCharacterName(requestedSpeaker);
            toastr.info(`Router override: ${forcedRouterSpeaker}`, EXTENSION_LABEL);
        }

        await runRouter(requestedSpeaker ? `manual:/router ${requestedSpeaker}` : 'manual');
        return '';
    }, [], 'Executa o router manualmente');

    ctx.registerSlashCommand?.('director', async () => {
        await runRouter('manual:/director');
        return '';
    }, [], 'Executa o SceneDirector manualmente');

    ctx.registerSlashCommand?.('routerwi', async () => {
        await testWorldInfoPrompt('slash:/routerwi');
        return '';
    }, [], 'Testa o World Info que seria injetado no prompt');

    ctx.registerSlashCommand?.('routervf', async () => {
        await testVectFoxPrompt('slash:/routervf');
        return '';
    }, [], 'Testa o VectFox que poderia alimentar o router');

    window.MultiCaller = {
        ...(window.MultiCaller ?? {}),
        testWorldInfoPrompt,
        testVectFoxPrompt,
        testVectFoxPromptVerbose: (caller = 'console') => testVectFoxPrompt(caller, { verbose: true }),
        lastDirectorRequest,
    };

    ctx.eventSource.on(ctx.event_types.USER_MESSAGE_RENDERED, () => {
        setTimeout(() => {
            handleUserTurnPipeline();
        }, 300);
    });

    ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(async () => {
            const c = SillyTavern.getContext();
            const lastMsg = c.chat[c.chat.length - 1];
            if (lastMsg?.extra?.type === 'tool_call' || lastMsg?.extra?.type === 'tool_response') {
                return; // ignora mensagens de tool call — GM ainda está gerando
            }
            if (skipNextCharacterAutoRouter) {
                skipNextCharacterAutoRouter = false;
                return;
            }
            await maybeTriggerRouterTimedLorebookFromMessage(lastMsg, c);
            runRouter('CHARACTER_MESSAGE_RENDERED');
        }, 300);
    });

    ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => {
        const c = SillyTavern.getContext();
        const lastMsg = c.chat[c.chat.length - 1];
        const type = lastMsg?.extra?.type;
        const isEmpty = !lastMsg?.mes?.trim();
        const isToolCycle = isEmpty || type === 'tool_call' || type === 'tool_response';
        fl('← EVT', 'GENERATION_ENDED', `isProcessing=${isProcessing} | type=${type ?? (isEmpty ? 'empty' : 'msg')} | toolCycle=${isToolCycle}`);
        if (!isProcessing) return;
        if (isToolCycle) {
            fl('  =', 'GENERATION_ENDED', 'tool_call pendente — mantendo isProcessing');
            return;
        }
        clearCharacterNote();
        clearStoryGuideInjection();
        clearLorebookInjection();
        clearDirectedOocPrompt();
        clearSceneDirection();
        skipNextCharacterAutoRouter = false;
        isProcessing = false;
        fl('  ✓', 'GENERATION_ENDED', 'isProcessing liberado');
        if (pendingAutoRouter) {
            pendingAutoRouter = false;
            setTimeout(() => {
                runRouter('GENERATION_ENDED:pending-auto');
            }, 0);
        }
    });

    ctx.eventSource.on(ctx.event_types.GENERATION_STOPPED, () => {
        fl('← EVT', 'GENERATION_STOPPED', `isProcessing=${isProcessing}`);
        if (!isProcessing) return;
        clearCharacterNote();
        clearStoryGuideInjection();
        clearLorebookInjection();
        clearDirectedOocPrompt();
        clearSceneDirection();
        skipNextCharacterAutoRouter = false;
        pendingAutoRouter = false;
        isProcessing = false;
        fl('  ✓', 'GENERATION_STOPPED', 'isProcessing liberado (stop forçado)');
    });

    ctx.eventSource.on(ctx.event_types.GROUP_MEMBER_DRAFTED, (charName) => {
        fl('← EVT', 'GROUP_MEMBER_DRAFTED', `char=${charName}`);
        lastActiveChar = charName;
    });

    ctx.eventSource.on(ctx.event_types.CHAT_COMPLETION_PROMPT_READY, ({ chat, dryRun }) => {
        if (dryRun) return;


        const noteMsg    = chat.findLast(m => m.role === 'system' && m.content?.includes('Write the next reply only as '));
        const match      = noteMsg?.content?.match(/Write the next reply only as (.+?)\./);
        const activeChar = match?.[1];

        const beforeSummary = {
            total: Array.isArray(chat) ? chat.length : 0,
            system: Array.isArray(chat) ? chat.filter(m => m.role === 'system').length : 0,
            user: Array.isArray(chat) ? chat.filter(m => m.role === 'user').length : 0,
            assistant: Array.isArray(chat) ? chat.filter(m => m.role === 'assistant').length : 0,
            nonSystemPreview: Array.isArray(chat)
                ? chat
                    .filter(m => m.role !== 'system')
                    .slice(0, 6)
                    .map(m => ({
                        role: m.role,
                        contentStart: String(m.content ?? '').slice(0, 120),
                    }))
                : [],
        };

        // Sempre remapeia: só o personagem ativo fica como assistant, todos os outros viram user
        if (activeChar) {
            let remapped = 0;
            for (const msg of chat) {
                if (msg.role !== 'assistant') continue;
                if (!String(msg.content ?? '').startsWith(activeChar + ':')) {
                    msg.role = 'user';
                    remapped++;
                }
            }
            const afterSummary = {
                total: Array.isArray(chat) ? chat.length : 0,
                system: Array.isArray(chat) ? chat.filter(m => m.role === 'system').length : 0,
                user: Array.isArray(chat) ? chat.filter(m => m.role === 'user').length : 0,
                assistant: Array.isArray(chat) ? chat.filter(m => m.role === 'assistant').length : 0,
                nonSystemPreview: Array.isArray(chat)
                    ? chat
                        .filter(m => m.role !== 'system')
                        .slice(0, 6)
                        .map(m => ({
                            role: m.role,
                            contentStart: String(m.content ?? '').slice(0, 120),
                        }))
                    : [],
            };
            console.log('[Backstage] CHAT_COMPLETION_PROMPT_READY summary', {
                activeChar,
                remapped,
                before: beforeSummary,
                after: afterSummary,
            });
            if (afterSummary.user + afterSummary.assistant === 0) {
                console.warn('[Backstage] Prompt ready without non-system chat messages for active character', {
                    activeChar,
                    before: beforeSummary,
                    after: afterSummary,
                });
            }
        }

    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        fl('← EVT', 'CHAT_CHANGED', `isProcessing=${isProcessing} | lastActiveChar=${lastActiveChar}`);
        lastActiveChar = null;
        loadGroupMembers();
    });

    ctx.eventSource.on(ctx.event_types.MAIN_API_CHANGED, (payload) => {
        if (!isProcessing) return;
        fl('← EVT', 'MAIN_API_CHANGED', `api=${payload?.apiId ?? ''} | lastActiveChar=${lastActiveChar}`);
    });

    ctx.eventSource.on(ctx.event_types.CHATCOMPLETION_SOURCE_CHANGED, (payload) => {
        if (!isProcessing) return;
        fl('← EVT', 'CHATCOMPLETION_SOURCE_CHANGED', `source=${payload?.source ?? payload ?? ''} | lastActiveChar=${lastActiveChar}`);
    });

    ctx.eventSource.on(ctx.event_types.OAI_PRESET_CHANGED_BEFORE, (payload) => {
        if (!isProcessing) return;
        fl('← EVT', 'OAI_PRESET_CHANGED_BEFORE', `payload=${JSON.stringify(payload ?? {})}`);
    });

    ctx.eventSource.on(ctx.event_types.OAI_PRESET_CHANGED_AFTER, (payload) => {
        if (!isProcessing) return;
        fl('← EVT', 'OAI_PRESET_CHANGED_AFTER', `payload=${JSON.stringify(payload ?? {})}`);
    });

    ctx.eventSource.on(ctx.event_types.CONNECTION_PROFILE_LOADED, (profileName) => {
        if (!isProcessing) return;
        fl('← EVT', 'CONNECTION_PROFILE_LOADED', `profile=${profileName ?? ''} | lastActiveChar=${lastActiveChar}`);
    });

    loadGroupMembers();

    console.log('[SceneDirector] Pronto!');
});
