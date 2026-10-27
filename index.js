import { refreshReadOnlyTokenCounters, scheduleTokenCounterUpdate } from './ui/token-counters.js';
import {
    AGENT_INJECTION_POSITIONS,
    applyAgentCharacterInjectionPrompts,
    clearAgentCharacterInjectionPrompts,
    formatAgentInjectionPlacement,
    normalizeAgentInjectionPlacement,
} from './agents/character-injection.js';
import {
    AGENT_LOG_LEVEL_OPTIONS,
    LOG_LEVEL_OPTIONS,
    backstageLogger,
    normalizeLogLevel,
} from './logging/logger.js';
import {
    executeAgentAction,
    validateAgentActionScript,
} from './agents/action-runner.js';
import {
    buildAgentGraphitiToolRuntime,
    getLongTermMemoryStatus,
    ingestLongTermMemoryEpisode,
    isValidGraphitiGroupId,
    searchLongTermMemory,
} from './agents/graphiti-tools.js';
import { runAgentToolConversation } from './agents/tool-call-runner.js';
import {
    AGENT_CONNECTION_MODES,
    AGENT_OWNER_TYPES,
    CHARACTER_AGENT_CONNECTION_MODES,
    findCharacterConnection,
    getAgentOwnerKey,
    normalizeAgentConnection,
    normalizeCharacterConnection,
    resolveAgentConnection,
} from './agents/connection-routing.js';
import { CancellationRegistry, isAbortError } from './runtime/cancellation.js';
import { getSectionSelection, mountSectionTabs, nestAgentSectionNavigation } from './ui/section-tabs.js';
import { formatAgentMessages, selectRpMessages, normalizeContextMessageOffset, sliceChatBeforeOffset } from './agents/rp-context.js';
import { getRegexedString, regex_placement } from '/scripts/extensions/regex/engine.js';
import { createSummaryCreation, DEFAULT_SUMMARY_CREATION_PROMPT, SUMMARY_CREATION_TYPE } from './memory/summary-creation.js';
import { buildSummaryInjection, fetchCharacterSummary, saveCharacterSummary } from './memory/character-summary.js';
import { createMemoryReinforcement } from './memory/reinforcement-runner.js';
import { createMemoryReinforcementLogger } from './logging/memory-reinforcement.js';
import { createCharacterSummaryPanel } from './ui/character-summary.js';
import { destroyTextEditors, flushTextEditors, mountTextEditors } from './ui/text-editors.js';
import {
    destroyAgentScriptEditor,
    getAgentScriptEditorValue,
    mountAgentScriptEditor,
} from './ui/agent-script-editor.js';

backstageLogger.info('Core', 'Loading extension');

const EXTENSION_NAME = 'MultiCaller';
const EXTENSION_DISPLAY_NAME = 'Backstage';
const EXTENSION_LABEL = 'Backstage';
const ROUTER_LABEL = 'Turn Router';
const CURRENT_CONFIG_VERSION = 15;
const PROFILE_SWITCH_SETTLE_QUIET_MS = 2000;
const PROFILE_SWITCH_SETTLE_MAX_WAIT_MS = 12000;
const PROFILE_SWITCH_SETTLE_EVENT_LIMIT = 12;
const AGENT_OUTPUT_SNAPSHOT_RETENTION = 3;
const AGENT_OUTPUT_SNAPSHOT_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_OPERATION_LOGS = 100;
const DEFAULT_AGENT_CONTEXT_MESSAGES = 100;
const DEFAULT_AGENT_MAX_TOOL_ROUNDS = 16;
const MAX_AGENT_TOOL_ROUNDS = 64;
const AGENT_SCHEDULE_TYPES = new Set(['manual', 'user-turns', 'total-turns', 'character-turns', 'before-character']);
const GRAPHITI_PERMISSION_TYPES = new Set(['search', 'remember', 'correct', 'forget']);
const LOCAL_CONFIG_STORAGE_KEY = `st_${EXTENSION_NAME}_settings`;
const LEGACY_CONFIG_BACKUP_KEY = `${LOCAL_CONFIG_STORAGE_KEY}_legacy_backup`;
const NATIVE_SETTINGS_NAMESPACE = 'backstage';
const NATIVE_SETTINGS_STORAGE_VERSION = 1;

const DEFAULT_ROUTER_PROMPT = `You are the RP Turn Router for a SillyTavern group roleplay.

You are invisible. You never write chat prose. You never narrate the scene.
Your only job is to decide who should speak next.

Use the recent chat, active characters, last speaker, and explicitly referenced agent outputs to preserve continuity and pacing.

Rules:
- Do not reveal information the selected character could not know.
- Do not force the user character's actions, thoughts, emotions, or dialogue.
- Prefer the character with the strongest immediate reason to act.
- If the scene needs the user to act, return USER as nextSpeaker.
- Never instruct, command, script, or imply the user's next action.
- Do not summarize all lore. Use only what matters now.
- Output valid JSON only. No markdown. No prose outside JSON.

Characters:
{{players}}

Last speaker:
{{lastSpeaker}}

Recent chat:
{{recentChat}}

Return:
{
  "nextSpeaker": "name or USER",
  "reason": "brief internal reason"
}`;

const ROUTER_OOC_DEFAULT_DRAFT = `OOC

Router pause the RP for a while`;
const AGENT_OOC_DEFAULT_DRAFT = `OOC

Pause the RP for a while`;

const DEFAULT_CONFIG = {
    configVersion:     CURRENT_CONFIG_VERSION,
    routerProfileId:   '',
    routerInputTokenBudget: 0,
    globalAgentProfileId: '',
    globalAgentProfileName: '',
    consoleLogLevel:  'debug',
    memorySearchLogs: true,
    enabled:           true,
    routerPrompt:      DEFAULT_ROUTER_PROMPT,
    characters: [],
    agents: [],
    // characters: [{ name, avatar, profileId, profileName, agentProfileMode, agentProfileId, agentProfileName }]
};

let config = { ...DEFAULT_CONFIG };
let isProcessing = false;
let lastActiveChar = null;
let activeCharacterGenerationGuard = null;
let contextSnapshotQueue = Promise.resolve();
const activeOperationLogIds = new Map();
let agentSchedulerQueue = Promise.resolve();
const runningAgentIds = new Set();
const runningAgentActionIds = new Set();
const cancellableOperations = new CancellationRegistry();
let sceneDirectorState = {
    panelOpen: false,
    activeTab: 'router',
    routerView: 'workspace',
    agentView: 'workspace',
    characterView: 'agents',
    characterConnectionsOpen: false,
    activeAgentOwnerKey: '',
    activeAgentId: '',
    routerStatus: 'idle',
    routerUpdatedAt: null,
    lastContext: null,
    lastDecision: null,
    lastReasoning: '',
    lastRawOutput: '',
    lastPromptMessages: null,
    routerOocDraft: ROUTER_OOC_DEFAULT_DRAFT,
    routerOocHistory: [],
    agentOocDrafts: {},
    agentOocHistories: {},
    persistentIssue: '',
    persistentIssueSource: '',
    persistentIssueAt: null,
    lastError: '',
    triggerSettle: null,
    operationLogs: [],
    memoryWorkspace: {
        groupId: '',
        sourceDescription: 'Backstage semantic bootstrap',
        selectedCharacterAvatars: [],
        selectedLorebooks: [],
        status: 'idle',
        completed: 0,
        total: 0,
        current: '',
        error: '',
        result: '',
    },
    evaluationWorkspace: {
        query: '',
        groupIds: '',
        count: 8,
        status: 'idle',
        durationMs: 0,
        result: '',
        error: '',
    },
    runtimeTiming: {
        activeKind: '',
        activeLabel: '',
        activeStartedAt: null,
        activeDetail: '',
        activeModel: '',
        lastCompletedKind: '',
        lastCompletedLabel: '',
        lastCompletedMs: null,
        lastCompletedAt: null,
        lastRouterMs: null,
        lastRouterAt: null,
        lastRouterModel: '',
        lastCharacterMs: null,
        lastCharacterAt: null,
        lastCharacterModel: '',
    },
};
let lastRouterRequest = null;
let forcedRouterSpeaker = null;
let skipNextCharacterAutoRouter = false;
let pendingAutoRouter = false;
let pendingNativeCharacterMessage = null;
const handledCharacterTurnMessages = new WeakSet();
let activeTriggerSettleMonitor = null;
let memoryIngestionController = null;
let routerPromptSaveTimer = null;

// ================= FLOW LOG =================

const T0 = Date.now();
function fl(direction, method, detail = '') {
    const t = ((Date.now() - T0) / 1000).toFixed(2);
    const det = detail ? ` | ${detail}` : '';
    backstageLogger.trace('Flow', `[${t}s] ${direction} ${method}${det}`);
}

// ================= CONFIG =================

function buildNativeRouterAgentConfig() {
    return {
        storageVersion: NATIVE_SETTINGS_STORAGE_VERSION,
        configVersion: CURRENT_CONFIG_VERSION,
        router: {
            enabled: config.enabled,
            profileId: config.routerProfileId,
            inputTokenBudget: config.routerInputTokenBudget,
            prompt: config.routerPrompt,
        },
        connections: {
            globalAgentProfileId: config.globalAgentProfileId,
            globalAgentProfileName: config.globalAgentProfileName,
            characters: structuredClone(config.characters),
        },
        logging: {
            level: config.consoleLogLevel,
            memorySearches: config.memorySearchLogs !== false,
        },
        agents: structuredClone(config.agents),
    };
}

function hasMeaningfulRouterAgentValues(value) {
    const source = value && typeof value === 'object' ? value : {};
    const agents = Array.isArray(source.agents) ? source.agents : [];
    const characters = Array.isArray(source.characters) ? source.characters : [];
    return agents.length > 0
        || !!String(source.routerProfileId ?? '').trim()
        || characters.some(character => String(character?.profileId ?? '').trim() || character?.summary?.namespace)
        || (!!String(source.routerPrompt ?? '').trim() && source.routerPrompt !== DEFAULT_ROUTER_PROMPT)
        || Math.max(0, parseInt(source.routerInputTokenBudget) || 0) !== DEFAULT_CONFIG.routerInputTokenBudget
        || !!String(source.globalAgentProfileId ?? '').trim()
        || normalizeLogLevel(source.consoleLogLevel, { fallback: DEFAULT_CONFIG.consoleLogLevel }) !== DEFAULT_CONFIG.consoleLogLevel
        || source.memorySearchLogs === false
        || source.enabled === false;
}

function applyNativeRouterAgentConfig(nativeSettings) {
    const router = nativeSettings?.router && typeof nativeSettings.router === 'object'
        ? nativeSettings.router
        : {};
    const logging = nativeSettings?.logging && typeof nativeSettings.logging === 'object'
        ? nativeSettings.logging
        : {};
    const connections = nativeSettings?.connections && typeof nativeSettings.connections === 'object'
        ? nativeSettings.connections
        : {};

    config.configVersion = CURRENT_CONFIG_VERSION;
    config.enabled = router.enabled ?? config.enabled;
    config.routerProfileId = String(router.profileId ?? config.routerProfileId ?? '');
    config.routerInputTokenBudget = Math.max(0, parseInt(router.inputTokenBudget) || 0);
    config.routerPrompt = String(router.prompt ?? config.routerPrompt ?? DEFAULT_ROUTER_PROMPT);
    config.globalAgentProfileId = String(connections.globalAgentProfileId ?? config.globalAgentProfileId ?? '');
    config.globalAgentProfileName = String(connections.globalAgentProfileName ?? config.globalAgentProfileName ?? '');
    const storedCharacters = Array.isArray(connections.characters) ? connections.characters : router.characters;
    config.characters = Array.isArray(storedCharacters)
        ? storedCharacters.map(normalizeCharacterConnection)
        : config.characters;
    config.consoleLogLevel = normalizeLogLevel(logging.level ?? config.consoleLogLevel, { fallback: DEFAULT_CONFIG.consoleLogLevel });
    config.memorySearchLogs = logging.memorySearches ?? config.memorySearchLogs ?? true;
    config.agents = normalizeAgentDefinitions(nativeSettings?.agents);
}

function saveConfig() {
    syncLoggerConfig();
    const ctx = SillyTavern.getContext();
    const nativeSettings = buildNativeRouterAgentConfig();
    const extensionSettingsRoot = ctx?.extensionSettings?.[EXTENSION_NAME];
    const currentNative = extensionSettingsRoot?.[NATIVE_SETTINGS_NAMESPACE];
    const hasNativeSettings = Number(currentNative?.storageVersion) >= NATIVE_SETTINGS_STORAGE_VERSION;
    const hasMeaningfulNativeValues = hasMeaningfulRouterAgentValues({
        ...config,
        agents: config.agents,
        characters: config.characters,
    });

    if (!hasNativeSettings && hasMeaningfulNativeValues && !localStorage.getItem(LEGACY_CONFIG_BACKUP_KEY)) {
        localStorage.setItem(LEGACY_CONFIG_BACKUP_KEY, JSON.stringify(config));
    }

    if (!ctx?.extensionSettings || (!hasNativeSettings && !hasMeaningfulNativeValues)) return;

    const currentNativeJson = JSON.stringify(currentNative ?? null);
    const nextNativeJson = JSON.stringify(nativeSettings);
    if (currentNativeJson === nextNativeJson) return;

    ctx.extensionSettings[EXTENSION_NAME] = {
        ...(extensionSettingsRoot && typeof extensionSettingsRoot === 'object' ? extensionSettingsRoot : {}),
        [NATIVE_SETTINGS_NAMESPACE]: nativeSettings,
    };
    ctx.saveSettingsDebounced?.();
}

function normalizeAgentId(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_:-]+/g, '-')
        .replace(/:+/g, ':')
        .replace(/^[-:]+|[-:]+$/g, '')
        .slice(0, 64);
}

function createUniqueAgentId(name, agents = config.agents) {
    const base = normalizeAgentId(name) || 'agent';
    const used = new Set((Array.isArray(agents) ? agents : []).map(agent => normalizeAgentId(agent?.id)));
    if (!used.has(base)) return base;

    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

function createAgentIdForOwner(name, owner = getActiveAgentOwner()) {
    const agentPart = normalizeAgentId(name) || 'agent';
    if (owner?.type !== AGENT_OWNER_TYPES.CHARACTER) {
        return createUniqueAgentId(agentPart);
    }

    const ownerPart = normalizeAgentId(owner.label || owner.character?.name) || 'character';
    return createUniqueAgentId(`${ownerPart}:${agentPart}`);
}

function replaceAgentIdReference(value, oldId, newId) {
    const escapedOldId = String(oldId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(value ?? '').replace(
        new RegExp(`{{\\s*agent:${escapedOldId}\\s*}}`, 'gi'),
        `{{agent:${newId}}}`,
    );
}

function renameAgentId(agent, requestedId, ctx = SillyTavern.getContext()) {
    const oldId = normalizeAgentId(agent?.id);
    const newId = normalizeAgentId(requestedId);
    if (!agent || !oldId) return { ok: false, error: 'No agent is selected.' };
    if (!newId) return { ok: false, error: 'Agent ID cannot be empty.' };
    if (newId === oldId) return { ok: true, id: oldId };
    if ((config.agents ?? []).some(item => item !== agent && normalizeAgentId(item.id) === newId)) {
        return { ok: false, error: `Agent ID "${newId}" is already in use.` };
    }
    if (runningAgentIds.has(oldId) || runningAgentActionIds.has(oldId)) {
        return { ok: false, error: 'Stop this agent before changing its ID.' };
    }

    const metadata = getAgentMetadata(ctx);
    if (metadata[oldId]) {
        metadata[newId] = metadata[oldId];
        delete metadata[oldId];
        ctx.saveMetadata?.();
    }

    for (const definition of config.agents ?? []) {
        definition.prompt = replaceAgentIdReference(definition.prompt, oldId, newId);
    }
    config.routerPrompt = replaceAgentIdReference(config.routerPrompt, oldId, newId);
    agent.id = newId;

    if (Object.hasOwn(sceneDirectorState.agentOocDrafts ?? {}, oldId)) {
        sceneDirectorState.agentOocDrafts[newId] = sceneDirectorState.agentOocDrafts[oldId];
        delete sceneDirectorState.agentOocDrafts[oldId];
    }
    if (Object.hasOwn(sceneDirectorState.agentOocHistories ?? {}, oldId)) {
        sceneDirectorState.agentOocHistories[newId] = sceneDirectorState.agentOocHistories[oldId];
        delete sceneDirectorState.agentOocHistories[oldId];
    }
    sceneDirectorState.operationLogs = (sceneDirectorState.operationLogs ?? []).map(log => log.agentId === oldId
        ? {
            ...log,
            agentId: newId,
            kind: String(log.kind ?? '').replace(`agent-ooc:${oldId}`, `agent-ooc:${newId}`).replace(`agent:${oldId}`, `agent:${newId}`),
        }
        : log);
    sceneDirectorState.activeAgentId = newId;
    saveConfig();
    return { ok: true, id: newId };
}

function normalizeGraphitiGroupIds(values) {
    const source = Array.isArray(values)
        ? values
        : String(values ?? '').split(/[\s,]+/);
    return [...new Set(source
        .map(value => String(value ?? '').trim())
        .filter(value => value && isValidGraphitiGroupId(value)))];
}

function normalizeGraphitiPermissions(values, defaults = []) {
    const source = Array.isArray(values) ? values : defaults;
    return [...new Set(source
        .map(value => String(value ?? '').trim().toLowerCase())
        .filter(value => GRAPHITI_PERMISSION_TYPES.has(value)))];
}

function normalizeAgentDefinition(agent, index = 0) {
    const internal = agent?.internalType === SUMMARY_CREATION_TYPE;
    const name = String(agent?.name ?? `Agent ${index + 1}`).trim() || `Agent ${index + 1}`;
    const scheduleType = AGENT_SCHEDULE_TYPES.has(String(agent?.scheduleType ?? 'manual'))
        ? String(agent.scheduleType)
        : 'manual';
    const injectionPlacement = normalizeAgentInjectionPlacement(agent);
    const connection = normalizeAgentConnection(agent);

    return {
        id: normalizeAgentId(agent?.id) || createUniqueAgentId(name, []),
        name,
        internalType: internal ? SUMMARY_CREATION_TYPE : '',
        displayOrder: Number.isFinite(agent?.displayOrder) ? agent.displayOrder : 0,
        enabled: agent?.enabled !== false,
        profileId: String(agent?.profileId ?? ''),
        profileName: String(agent?.profileName ?? ''),
        ownerType: connection.ownerType,
        ownerCharacterAvatar: connection.ownerCharacterAvatar,
        ownerCharacterName: connection.ownerCharacterName,
        connectionMode: connection.connectionMode,
        prompt: String(agent?.prompt ?? ''),
        includeHiddenMessages: agent?.includeHiddenMessages === true,
        applyPromptRegex: agent?.applyPromptRegex === true,
        scheduleType,
        interval: Math.min(10000, Math.max(1, parseInt(agent?.interval) || 5)),
        characterName: String(agent?.characterName ?? '').trim(),
        referenceCharacterAvatar: String(agent?.referenceCharacterAvatar ?? ''),
        referenceCharacterName: String(agent?.referenceCharacterName ?? '').trim(),
        worldInfoBooks: Array.isArray(agent?.worldInfoBooks)
            ? agent.worldInfoBooks.map(name => String(name ?? '').trim()).filter(Boolean)
            : [],
        graphitiOocEnabled: !internal && (agent?.graphitiOocEnabled === true || agent?.graphitiToolEnabled === true),
        graphitiAutomaticEnabled: !internal && agent?.graphitiAutomaticEnabled === true,
        graphitiReadGroupIds: normalizeGraphitiGroupIds(agent?.graphitiReadGroupIds),
        graphitiWriteGroupId: isValidGraphitiGroupId(agent?.graphitiWriteGroupId)
            ? String(agent.graphitiWriteGroupId).trim()
            : '',
        graphitiOocPermissions: normalizeGraphitiPermissions(
            agent?.graphitiOocPermissions,
            ['search', 'remember', 'correct', 'forget'],
        ),
        graphitiAutomaticPermissions: normalizeGraphitiPermissions(
            agent?.graphitiAutomaticPermissions,
            ['search', 'remember'],
        ),
        logLevel: AGENT_LOG_LEVEL_OPTIONS.includes(String(agent?.logLevel ?? '').trim().toLowerCase())
            ? String(agent.logLevel).trim().toLowerCase()
            : 'inherit',
        contextMessages: Math.min(5000, Math.max(1, parseInt(agent?.contextMessages) || DEFAULT_AGENT_CONTEXT_MESSAGES)),
        contextMessageOffset: normalizeContextMessageOffset(agent?.contextMessageOffset),
        maxToolRounds: Math.min(MAX_AGENT_TOOL_ROUNDS, Math.max(1, parseInt(agent?.maxToolRounds) || DEFAULT_AGENT_MAX_TOOL_ROUNDS)),
        validateOutputFormat: !internal && agent?.validateOutputFormat === true,
        actionEnabled: !internal && agent?.actionEnabled === true,
        actionAutoRun: agent?.actionAutoRun === true,
        actionScript: String(agent?.actionScript ?? ''),
        actionTestPayload: String(agent?.actionTestPayload ?? '{\n    "example": true\n}'),
        characterInjectionEnabled: !internal && agent?.characterInjectionEnabled === true,
        characterInjectionPosition: injectionPlacement.position,
        characterInjectionDepth: injectionPlacement.depth,
        characterInjectionRole: injectionPlacement.role,
        characterInjectionTargets: normalizeCharacterInjectionTargets(agent?.characterInjectionTargets),
    };
}

function normalizeOutputTagName(value) {
    return String(value ?? '')
        .trim()
        .replace(/^<\/?\s*/, '')
        .replace(/\s*>$/, '')
        .trim();
}

function isValidXmlTagName(value) {
    return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(normalizeOutputTagName(value));
}

function normalizeCharacterInjectionTargets(targets) {
    return (Array.isArray(targets) ? targets : [])
        .map(target => ({
            characterAvatar: String(target?.characterAvatar ?? ''),
            characterName: String(target?.characterName ?? '').trim(),
            mode: target?.mode === 'full' ? 'full' : 'tag',
            tag: normalizeOutputTagName(target?.tag),
            optional: target?.optional === true,
        }))
        .filter(target => target.characterAvatar || target.characterName);
}

function normalizeAgentDefinitions(agents) {
    const normalized = [];
    const used = new Set();

    for (const source of Array.isArray(agents) ? agents : []) {
        const agent = normalizeAgentDefinition(source, normalized.length);
        const baseId = agent.id;
        let candidate = baseId;
        let suffix = 2;
        while (used.has(candidate)) candidate = `${baseId}-${suffix++}`;
        agent.id = candidate;
        used.add(candidate);
        normalized.push(agent);
    }

    return normalized;
}

function getAgentLogScope(agentOrId) {
    const id = typeof agentOrId === 'object' ? agentOrId?.id : agentOrId;
    return `Agent:${normalizeAgentId(id) || 'unknown'}`;
}

function syncLoggerConfig() {
    backstageLogger.configure({
        level: normalizeLogLevel(config.consoleLogLevel, { fallback: DEFAULT_CONFIG.consoleLogLevel }),
        scopes: Object.fromEntries(
            normalizeAgentDefinitions(config.agents)
                .filter(agent => agent.logLevel !== 'inherit')
                .map(agent => [getAgentLogScope(agent), agent.logLevel]),
        ),
    });
}

function needsRouterPromptRefresh(prompt) {
    return !String(prompt ?? '').trim();
}

function migrateConfig() {
    const previousVersion = Number(config.configVersion || 1);

    if (previousVersion < CURRENT_CONFIG_VERSION) {
        if (needsRouterPromptRefresh(config.routerPrompt)) {
            config.routerPrompt = DEFAULT_ROUTER_PROMPT;
        }
        if (config.routerInputTokenBudget == null) {
            config.routerInputTokenBudget = 0;
        }
        config.routerInputTokenBudget = Math.max(0, parseInt(config.routerInputTokenBudget) || 0);
        config.characters = (Array.isArray(config.characters) ? config.characters : []).map(normalizeCharacterConnection);
        config.agents = normalizeAgentDefinitions(config.agents);
        delete config.maxTokens;
        config.configVersion = CURRENT_CONFIG_VERSION;
        saveConfig();
    }
}

function parseStoredConfig(storageKey) {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { raw: '', value: null };

    try {
        const value = JSON.parse(raw);
        return { raw, value: value && typeof value === 'object' ? value : null };
    } catch (error) {
        backstageLogger.warn('Config', `Could not parse stored config ${storageKey}`, error);
        return { raw, value: null };
    }
}

function loadConfig() {
    const currentLocal = parseStoredConfig(LOCAL_CONFIG_STORAGE_KEY);
    const legacyBackup = parseStoredConfig(LEGACY_CONFIG_BACKUP_KEY);
    const legacySource = hasMeaningfulRouterAgentValues(currentLocal.value)
        ? currentLocal.value
        : (hasMeaningfulRouterAgentValues(legacyBackup.value) ? legacyBackup.value : null);
    config = {
        ...DEFAULT_CONFIG,
        ...(legacySource ?? {}),
        ...(currentLocal.value ?? {}),
    };

    const ctx = SillyTavern.getContext();
    const nativeSettings = ctx?.extensionSettings?.[EXTENSION_NAME]?.[NATIVE_SETTINGS_NAMESPACE];
    const hasNativeSettings = Number(nativeSettings?.storageVersion) >= NATIVE_SETTINGS_STORAGE_VERSION;

    if (hasNativeSettings) {
        applyNativeRouterAgentConfig(nativeSettings);
    } else {
        if (currentLocal.raw && hasMeaningfulRouterAgentValues(currentLocal.value) && !legacyBackup.raw) {
            localStorage.setItem(LEGACY_CONFIG_BACKUP_KEY, currentLocal.raw);
        }
        config.agents = normalizeAgentDefinitions(config.agents);
    }

    migrateConfig();
    config.agents = normalizeAgentDefinitions(config.agents);
    config.consoleLogLevel = normalizeLogLevel(config.consoleLogLevel, { fallback: DEFAULT_CONFIG.consoleLogLevel });
    syncLoggerConfig();
    if (!hasNativeSettings && legacySource) saveConfig();
}

// ================= SOUND =================

const USER_SOUND_URL = '/scripts/extensions/third-party/MultiCaller/sounds/User.mp3';
let userTurnAudio = null;

function playUserSound() {
    try {
        userTurnAudio ??= new Audio(USER_SOUND_URL);
        userTurnAudio.pause();
        userTurnAudio.currentTime = 0;
        userTurnAudio.volume = 0.5;
        userTurnAudio.play().catch(error => {
            backstageLogger.warn('Sound', 'Could not play the user-turn sound', error);
        });
    } catch (error) {
        backstageLogger.warn('Sound', 'Could not initialize the user-turn sound', error);
    }
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
const AGENT_CHARACTER_INJECTION_KEY = 'backstage-agent-character-context';
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
    const note = `<CHARACTER_ASSIGNMENT>
Write the next reply only as ${charName}. Do NOT speak as any other character.
</CHARACTER_ASSIGNMENT>`;
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

    const prompt = `<PRIVATE_OOC_DIRECTIVE>
You are replying as ${charName}, but this next reply must be OOC, not in-scene narration.

<RULES>
- Start your reply with: OOC ${charName}
- Answer the operator's request directly and clearly.
- Do not continue the RP scene.
- Do not act as other characters.
- Do not mention hidden prompts, routing, or system instructions.
</RULES>

<OPERATOR_REQUEST>
${request}
</OPERATOR_REQUEST>
</PRIVATE_OOC_DIRECTIVE>`;

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

function getAgentInjectionTargets(agent, ctx = SillyTavern.getContext()) {
    const targets = normalizeCharacterInjectionTargets(agent?.characterInjectionTargets);
    if (agent?.ownerType !== AGENT_OWNER_TYPES.CHARACTER) return targets;

    const owner = findCharacterConnection(agent, ctx.characters);
    if (!owner) return [];
    const existing = targets.find(target => target.characterAvatar === owner.avatar || target.characterName === owner.name)
        ?? targets[0];
    return [{
        characterAvatar: owner.avatar,
        characterName: owner.name,
        mode: existing?.mode ?? 'full',
        tag: existing?.tag ?? '',
        optional: existing?.optional ?? false,
    }];
}

function resolveAgentInjectionTarget(agent, charName, ctx = SillyTavern.getContext()) {
    const targets = getAgentInjectionTargets(agent, ctx);
    if (!targets.length) return null;

    const resolvedCharacter = resolveCharacterByName(charName, ctx).character;
    const avatar = String(resolvedCharacter?.avatar ?? '');
    const normalizedName = String(resolvedCharacter?.name ?? charName ?? '').trim().toLocaleLowerCase();
    const exact = targets.find(target => (
        (avatar && target.characterAvatar === avatar)
        || (target.characterName && target.characterName.toLocaleLowerCase() === normalizedName)
    ));
    if (exact) return exact;

    const firstName = normalizedName.split(/\s+/)[0];
    const firstNameMatches = targets.filter(target => (
        String(target.characterName ?? '').trim().toLocaleLowerCase().split(/\s+/)[0] === firstName
    ));
    return firstNameMatches.length === 1 ? firstNameMatches[0] : null;
}

function isEmptyAgentInjectionContent(content) {
    const textOnly = String(content ?? '')
        .replace(/<\/?[A-Za-z_][A-Za-z0-9_.:-]*\s*>/g, '')
        .trim();
    return /^(?:-\s*)?none[.!]?$/i.test(textOnly);
}

function validateAgentOutput(agent, output) {
    const targets = agent?.characterInjectionEnabled ? getAgentInjectionTargets(agent) : [];
    if (agent?.validateOutputFormat) {
        const optionalTags = targets.filter(target => target.mode === 'tag' && target.optional
            && !targets.some(other => other.mode === 'tag' && other.tag === target.tag && !other.optional))
            .map(target => target.tag);
        const formatValidation = validateTaggedOutputFormat(agent.prompt, output, optionalTags);
        if (!formatValidation.valid) return formatValidation;
    }

    if (agent?.characterInjectionEnabled) {
        for (const target of targets) {
            if (target.mode !== 'tag') continue;
            const extracted = extractTaggedOutputSection(output, target.tag, target.optional);
            if (!extracted.valid) {
                return {
                    valid: false,
                    error: `Character injection for ${target.characterName || 'unknown character'} is invalid: ${extracted.error}`,
                };
            }
        }
    }

    return { valid: true, error: '' };
}

function buildAgentCharacterInjection(charName, ctx = SillyTavern.getContext()) {
    const deliveries = [];
    const errors = [];

    for (const agent of Array.isArray(config.agents) ? config.agents : []) {
        if (!agent.characterInjectionEnabled) continue;
        const target = resolveAgentInjectionTarget(agent, charName, ctx);
        if (!target) continue;

        const output = getAgentRuntimeState(agent.id, ctx).output.trim();
        if (!output) continue;
        const outputValidation = validateAgentOutput(agent, output);
        if (!outputValidation.valid) {
            errors.push(`${agent.name}: ${outputValidation.error}`);
            continue;
        }

        if (target.mode === 'full') {
            deliveries.push({ agent, target, content: output });
            continue;
        }

        const extracted = extractTaggedOutputSection(output, target.tag, target.optional);
        if (!extracted.valid) {
            errors.push(`${agent.name}: ${extracted.error}`);
            continue;
        }
        if (!extracted.content || isEmptyAgentInjectionContent(extracted.content)) continue;
        deliveries.push({ agent, target, content: extracted.block });
    }

    const deliveriesByAgent = new Map();
    for (const delivery of deliveries) {
        const agentId = String(delivery.agent.id);
        const group = deliveriesByAgent.get(agentId) ?? { agent: delivery.agent, deliveries: [] };
        group.deliveries.push(delivery);
        deliveriesByAgent.set(agentId, group);
    }

    const injections = [...deliveriesByAgent.values()].map(group => ({
        agent: group.agent,
        deliveries: group.deliveries,
        prompt: group.deliveries.map(delivery => delivery.content).join('\n\n'),
    }));

    return {
        injections,
        deliveries,
        errors,
    };
}

function applyAgentCharacterInjection(charName) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') {
        return {
            injections: [],
            deliveries: [],
            applied: [],
            errors: ['SillyTavern setExtensionPrompt is unavailable.'],
        };
    }

    const result = buildAgentCharacterInjection(charName, ctx);
    const character = config.characters.find(item => item.name === charName);
    const summaryInjection = character ? buildSummaryInjection(ctx, character) : null;
    if (summaryInjection) result.injections.push(summaryInjection);
    if (result.errors.length) {
        recordBackstageIssue(`Agent injection: ${charName}`, result.errors.join(' | '));
    }
    const applied = applyAgentCharacterInjectionPrompts(
        ctx,
        AGENT_CHARACTER_INJECTION_KEY,
        result.injections,
    );
    return { ...result, applied };
}

function clearAgentCharacterInjection() {
    const ctx = SillyTavern.getContext();
    clearAgentCharacterInjectionPrompts(ctx, AGENT_CHARACTER_INJECTION_KEY);
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

// ================= CONNECTION SERVICE =================

let _connService = null;
async function getConnService() {
    if (!_connService) {
        const mod = await import('/scripts/extensions/shared.js');
        _connService = mod.ConnectionManagerRequestService;
    }
    return _connService;
}

async function sendAgentStreamingRequest(profileId, messages, signal = null) {
    const service = await getConnService();
    signal?.throwIfAborted();
    const response = await service.sendRequest(
        profileId,
        messages,
        undefined,
        { stream: true, extractData: true, signal },
    );
    signal?.throwIfAborted();

    if (typeof response !== 'function') {
        return response;
    }

    let content = '';
    let reasoning = '';
    const generator = response();

    for await (const chunk of generator) {
        signal?.throwIfAborted();
        content = String(chunk?.text ?? content);
        reasoning = String(chunk?.state?.reasoning ?? reasoning);
    }

    signal?.throwIfAborted();
    return { content, reasoning };
}

async function sendAgentToolRequest(profileId, messages, logId, toolRuntime, maxRounds, signal = null) {
    const service = await getConnService();

    return runAgentToolConversation({
        messages,
        tools: toolRuntime.schemas,
        validateToolCall: toolRuntime.validateCall,
        sendRawRequest: (roundMessages, tools) => service.sendRequest(
            profileId,
            roundMessages,
            undefined,
            { stream: false, extractData: false, signal },
            { tools, tool_choice: 'auto' },
        ),
        onEvent: event => {
            if (event.type === 'request') {
                appendOperationLogDetail(
                    logId,
                    `Tool-call round ${event.round}: sending ${event.messageCount} messages.`,
                );
                const current = (sceneDirectorState.operationLogs ?? []).find(log => log.id === logId);
                const requestPayload = sanitizeRequestPayloadForLog({
                    messages: event.messages,
                    tools: event.tools,
                    tool_choice: 'auto',
                });
                const requestBlock = `# Agent Tool API Request ${event.round}\n${JSON.stringify(requestPayload, null, 2)}`;
                updateOperationLog(logId, {
                    request: current?.request ? `${current.request}\n\n${requestBlock}` : requestBlock,
                });
                return;
            }

            if (event.type === 'response') {
                const calls = event.toolCalls?.map(call => call.function?.name).filter(Boolean) ?? [];
                appendOperationLogDetail(
                    logId,
                    `Tool-call round ${event.round}: ${calls.length ? `requested ${calls.join(', ')}` : 'returned final text'}.`,
                );
                return;
            }

            if (event.type === 'tool-result') {
                appendOperationLogDetail(logId, [
                    `Tool execution: ${event.name}`,
                    `Arguments: ${event.arguments}`,
                    `Status: ${event.error ? 'error' : 'success'}`,
                    `Result: ${event.result}`,
                ].join('\n'));
            }
        },
        maxRounds,
        signal,
    });
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

function buildTriggerSettleSnapshot(monitor, status, note = '') {
    return {
        status,
        note,
        charName: monitor.charName,
        profileName: monitor.profileName,
        quietMs: monitor.quietMs,
        maxWaitMs: monitor.maxWaitMs,
        anchorSeen: !!monitor.anchorSeen,
        anchorEventName: monitor.anchorEventName,
        startedAt: new Date(monitor.startedAt),
        deadlineAt: new Date(monitor.deadlineAt),
        lastEventAt: monitor.lastEventAt ? new Date(monitor.lastEventAt) : null,
        lastEventName: monitor.lastEventName,
        events: monitor.events.slice().reverse(),
    };
}

function publishTriggerSettleSnapshot(monitor, status, note = '') {
    const patch = {
        triggerSettle: buildTriggerSettleSnapshot(monitor, status, note),
    };

    if (status === 'waiting') {
        patch.status = 'settling-profile';
    }

    updateRouterState(patch);
}

function buildChatRecoveryAnchor(ctx = SillyTavern.getContext()) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const messages = chat
        .filter(message => !message?.is_system && String(message?.mes ?? '').trim())
        .slice(-3)
        .map(message => JSON.stringify({
            name: String(message?.name ?? ''),
            is_user: !!message?.is_user,
            mes: String(message?.mes ?? ''),
        }));

    return {
        chatLength: chat.length,
        messages,
    };
}

function hasRecoveredChatAnchor(anchor, ctx = SillyTavern.getContext()) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!anchor?.messages?.length) {
        return chat.length >= Math.max(0, Number(anchor?.chatLength) || 0);
    }

    const currentMessages = chat
        .filter(message => !message?.is_system && String(message?.mes ?? '').trim())
        .slice(-anchor.messages.length)
        .map(message => JSON.stringify({
            name: String(message?.name ?? ''),
            is_user: !!message?.is_user,
            mes: String(message?.mes ?? ''),
        }));

    return currentMessages.length === anchor.messages.length
        && currentMessages.every((message, index) => message === anchor.messages[index]);
}

async function waitForStableChatRecovery(anchor, stableMs = PROFILE_SWITCH_SETTLE_QUIET_MS, maxWaitMs = PROFILE_SWITCH_SETTLE_MAX_WAIT_MS) {
    const startedAt = Date.now();
    let stableSince = null;

    while (Date.now() - startedAt < maxWaitMs) {
        if (hasRecoveredChatAnchor(anchor)) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= stableMs) {
                return true;
            }
        } else {
            stableSince = null;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false;
}

function clearActiveTriggerSettleMonitor(reason = 'Profile settle monitor cleared.') {
    if (!activeTriggerSettleMonitor) {
        return;
    }

    const monitor = activeTriggerSettleMonitor;
    if (typeof monitor.cancel === 'function') {
        monitor.cancel(reason);
        return;
    }

    clearTimeout(monitor.quietTimer);
    clearTimeout(monitor.maxTimer);
    clearTimeout(monitor.pollTimer);
    activeTriggerSettleMonitor = null;
}

function beginTriggerSettleMonitor(charName, profileName, quietMs = PROFILE_SWITCH_SETTLE_QUIET_MS, maxWaitMs = PROFILE_SWITCH_SETTLE_MAX_WAIT_MS) {
    clearActiveTriggerSettleMonitor();

    const monitor = {
        charName,
        profileName,
        quietMs: Math.max(250, Number(quietMs) || PROFILE_SWITCH_SETTLE_QUIET_MS),
        maxWaitMs: Math.max(1000, Number(maxWaitMs) || PROFILE_SWITCH_SETTLE_MAX_WAIT_MS),
        startedAt: Date.now(),
        deadlineAt: Date.now() + Math.max(1000, Number(maxWaitMs) || PROFILE_SWITCH_SETTLE_MAX_WAIT_MS),
        anchorSeen: false,
        anchorEventName: '',
        lastEventAt: null,
        lastEventName: '',
        events: [],
        quietTimer: null,
        maxTimer: null,
        pollTimer: null,
        finished: false,
        armed: false,
        recoveryAnchor: null,
        resolve: null,
        promise: null,
        cancel: null,
    };

    const scheduleQuietTimer = () => {
        clearTimeout(monitor.quietTimer);
        monitor.deadlineAt = Date.now() + monitor.quietMs;
        publishTriggerSettleSnapshot(monitor, 'waiting', `Waiting for ${monitor.quietMs}ms of silence before /trigger.`);
        monitor.quietTimer = setTimeout(() => {
            finish('settled', 'Quiet window reached. Proceeding with /trigger.');
        }, monitor.quietMs);
    };

    const finish = (status, note) => {
        if (monitor.finished) {
            return;
        }

        monitor.finished = true;
        clearTimeout(monitor.quietTimer);
        clearTimeout(monitor.maxTimer);
        clearTimeout(monitor.pollTimer);

        if (activeTriggerSettleMonitor === monitor) {
            activeTriggerSettleMonitor = null;
        }

        publishTriggerSettleSnapshot(monitor, status, note);
        monitor.resolve?.({
            status,
            note,
            events: monitor.events.slice(),
            quietMs: monitor.quietMs,
            maxWaitMs: monitor.maxWaitMs,
        });
    };
    monitor.cancel = note => finish('cancelled', String(note || 'Profile settle monitor cancelled.'));

    const checkChatRecovery = () => {
        if (monitor.finished || !monitor.armed) {
            return;
        }

        if (!monitor.anchorSeen && hasRecoveredChatAnchor(monitor.recoveryAnchor)) {
            monitor.anchorSeen = true;
            monitor.anchorEventName = `chat-tail:${monitor.recoveryAnchor.messages.length}`;
            monitor.events.push({
                name: 'CHAT_RECOVERED',
                detail: `chatLength=${SillyTavern.getContext()?.chat?.length ?? 0}`,
                at: new Date(),
            });
            scheduleQuietTimer();
        }

        if (!monitor.anchorSeen) {
            publishTriggerSettleSnapshot(monitor, 'waiting-anchor', 'Profile applied. Waiting for the pre-switch chat tail to recover.');
        }

        clearTimeout(monitor.pollTimer);
        monitor.pollTimer = setTimeout(checkChatRecovery, 100);
    };

    monitor.noteEvent = (eventName, detail = '') => {
        if (monitor.finished) {
            return;
        }

        const when = Date.now();
        monitor.lastEventAt = when;
        monitor.lastEventName = String(eventName ?? '').trim();
        monitor.events.push({
            name: String(eventName ?? '').trim(),
            detail: String(detail ?? '').trim(),
            at: new Date(when),
        });
        if (monitor.events.length > PROFILE_SWITCH_SETTLE_EVENT_LIMIT) {
            monitor.events.splice(0, monitor.events.length - PROFILE_SWITCH_SETTLE_EVENT_LIMIT);
        }

        if (!monitor.armed) {
            publishTriggerSettleSnapshot(monitor, 'applying-profile', 'Recording native events while the connection profile is applied.');
            return;
        }

        checkChatRecovery();
        if (monitor.anchorSeen) {
            scheduleQuietTimer();
        }
    };

    monitor.armRecovery = recoveryAnchor => {
        if (monitor.finished || monitor.armed) {
            return;
        }

        monitor.armed = true;
        monitor.recoveryAnchor = recoveryAnchor;
        monitor.deadlineAt = Date.now() + monitor.maxWaitMs;
        monitor.maxTimer = setTimeout(() => {
            finish(
                'failed',
                monitor.anchorSeen
                    ? `Chat recovered, but native profile events did not remain quiet for ${monitor.quietMs}ms within ${monitor.maxWaitMs}ms.`
                    : `Pre-switch chat did not recover within ${monitor.maxWaitMs}ms. Character generation was cancelled.`,
            );
        }, monitor.maxWaitMs);
        checkChatRecovery();
    };

    monitor.promise = new Promise(resolve => {
        monitor.resolve = resolve;
    });

    activeTriggerSettleMonitor = monitor;
    publishTriggerSettleSnapshot(monitor, 'applying-profile', 'Recording native events while the connection profile is applied.');
    return monitor;
}

function noteTriggerSettleEvent(eventName, detail = '') {
    if (!activeTriggerSettleMonitor || activeTriggerSettleMonitor.finished) {
        return;
    }

    activeTriggerSettleMonitor.noteEvent(eventName, detail);
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

async function getSelectedWorldInfoContext(ctx, selectedBooks = []) {
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

async function getSelectedWorldInfoCatalog(selectedBooks = [], options = {}) {
    const books = (Array.isArray(selectedBooks) ? selectedBooks : [])
        .map(name => String(name ?? '').trim())
        .filter(Boolean);
    const fullContent = !!options.fullContent;

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
                const content = String(entry?.content ?? '').trim();
                const flags = [
                    entry?.disable ? 'disabled' : 'enabled',
                    entry?.constant ? 'constant' : '',
                ].filter(Boolean);

                if (fullContent) {
                    return [
                        `### ${comment || `UID ${uid || '?'}`}`,
                        `UID: ${uid || '?'}`,
                        keys.length ? `Keys: ${keys.join(', ')}` : '',
                        flags.length ? `Flags: ${flags.join(', ')}` : '',
                        content ? `Content:\n${content}` : 'Content: (empty)',
                    ].filter(Boolean).join('\n');
                }

                const compactContent = content.replace(/\s+/g, ' ');
                return [
                    `- UID: ${uid || '?'}`,
                    comment ? `Name: ${comment}` : '',
                    keys.length ? `Keys: ${keys.join(', ')}` : '',
                    flags.length ? `Flags: ${flags.join(', ')}` : '',
                    compactContent ? `Content: ${compactContent.slice(0, 220)}${compactContent.length > 220 ? '...' : ''}` : '',
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
        backstageLogger.warn('WorldInfo', 'Failed to build World Info catalog', error);
        return {
            text: '',
            source: 'error',
            selectedBooks: books,
            entryCount: 0,
        };
    }
}

function buildCharacterMemoryEpisode(character) {
    const fields = [
        ['Description', getCharacterCardValue(character, 'description')],
        ['Personality', getCharacterCardValue(character, 'personality')],
        ['Scenario', getCharacterCardValue(character, 'scenario')],
        ['Creator notes', getCharacterCardValue(character, 'creator_notes', 'creatorcomment')],
    ].filter(([, value]) => value);
    return {
        name: `Character card: ${String(character?.name ?? 'Unknown')}`,
        content: [
            `Canonical character: ${String(character?.name ?? 'Unknown')}`,
            ...fields.map(([label, value]) => `${label}:\n${value}`),
        ].join('\n\n'),
    };
}

async function buildLorebookMemoryEpisodes(bookNames) {
    const wi = await getWorldInfoModule();
    const available = new Set(getAvailableWorldInfoNames(wi));
    const episodes = [];

    for (const bookName of Array.isArray(bookNames) ? bookNames : []) {
        if (!available.has(bookName) || typeof wi.loadWorldInfo !== 'function') continue;
        const data = await wi.loadWorldInfo(bookName);
        for (const entry of Object.values(data?.entries ?? {})) {
            const content = String(entry?.content ?? '').trim();
            if (!content) continue;
            const uid = String(entry?.uid ?? '?');
            const title = String(entry?.comment ?? '').trim() || `UID ${uid}`;
            const keys = Array.isArray(entry?.key)
                ? entry.key.map(value => String(value ?? '').trim()).filter(Boolean)
                : [];
            episodes.push({
                name: `Lorebook ${bookName}: ${title}`,
                content: [
                    `Lorebook: ${bookName}`,
                    `Entry: ${title}`,
                    `UID: ${uid}`,
                    keys.length ? `Keywords: ${keys.join(', ')}` : '',
                    content,
                ].filter(Boolean).join('\n'),
            });
        }
    }

    return episodes;
}

function captureMemoryWorkspaceFields() {
    const workspace = sceneDirectorState.memoryWorkspace;
    if ($('#memory-group-id').length) workspace.groupId = String($('#memory-group-id').val() ?? '').trim();
    if ($('#memory-source-description').length) workspace.sourceDescription = String($('#memory-source-description').val() ?? '').trim();
    if ($('#memory-source-characters').length) {
        workspace.selectedCharacterAvatars = $('#memory-source-characters input:checked').map((_, input) => String(input.value)).get();
    }
    if ($('#memory-source-lorebooks').length) {
        workspace.selectedLorebooks = $('#memory-source-lorebooks input:checked').map((_, input) => String(input.value)).get();
    }
}

async function runMemoryIngestion() {
    captureMemoryWorkspaceFields();
    const workspace = sceneDirectorState.memoryWorkspace;
    if (!isValidGraphitiGroupId(workspace.groupId)) throw new Error('Enter a valid destination memory group.');
    if (memoryIngestionController) throw new Error('A memory ingestion is already running.');

    const ctx = SillyTavern.getContext();
    const selectedCharacters = (ctx.characters ?? []).filter(character => workspace.selectedCharacterAvatars.includes(String(character?.avatar ?? '')));
    const episodes = [
        ...selectedCharacters.map(buildCharacterMemoryEpisode),
        ...await buildLorebookMemoryEpisodes(workspace.selectedLorebooks),
    ];
    if (!episodes.length) throw new Error('Select at least one character card or non-empty lorebook.');

    const logId = beginOperationLog('memory-ingestion', 'Memory ingestion', `${episodes.length} semantic sources`, 'Long-term memory');
    memoryIngestionController = new AbortController();
    Object.assign(workspace, { status: 'running', completed: 0, total: episodes.length, current: '', error: '', result: '' });
    refreshSceneDirectorPanel();
    const results = [];

    try {
        for (const episode of episodes) {
            workspace.current = episode.name;
            refreshSceneDirectorPanel();
            const result = await ingestLongTermMemoryEpisode({
                groupId: workspace.groupId,
                name: episode.name,
                content: episode.content,
                sourceDescription: workspace.sourceDescription || 'Backstage semantic bootstrap',
            }, memoryIngestionController.signal);
            results.push({ name: episode.name, result });
            workspace.completed += 1;
        }
        workspace.status = 'success';
        workspace.current = '';
        workspace.result = JSON.stringify(results, null, 2);
        updateOperationLog(logId, { response: workspace.result, detail: `Group: ${workspace.groupId}\nEpisodes: ${episodes.length}` });
        completeOperationLog(logId, 'success');
    } catch (error) {
        const stopped = error?.name === 'AbortError';
        workspace.status = stopped ? 'stopped' : 'error';
        workspace.error = stopped ? 'Ingestion stopped by operator.' : (error?.message ?? String(error));
        updateOperationLog(logId, { error: workspace.error, detail: `Completed ${workspace.completed} of ${workspace.total}` });
        completeOperationLog(logId, stopped ? 'stopped' : 'error');
        if (!stopped) throw error;
    } finally {
        memoryIngestionController = null;
        refreshSceneDirectorPanel();
    }
}

async function runMemoryEvaluation() {
    const workspace = sceneDirectorState.evaluationWorkspace;
    workspace.query = String($('#evaluation-query').val() ?? workspace.query).trim();
    workspace.groupIds = String($('#evaluation-group-ids').val() ?? workspace.groupIds).trim();
    workspace.count = Math.min(50, Math.max(1, Number($('#evaluation-count').val()) || workspace.count || 8));
    if (!workspace.query) throw new Error('Enter a semantic query.');

    const startedAt = performance.now();
    const logId = beginOperationLog('memory-evaluation', 'RAG retrieval test', workspace.query, 'Long-term memory');
    updateOperationLog(logId, {
        request: JSON.stringify({ query: workspace.query, groupIds: workspace.groupIds, count: workspace.count }, null, 2),
    });
    Object.assign(workspace, { status: 'running', error: '', result: '' });
    refreshSceneDirectorPanel();
    try {
        const result = await searchLongTermMemory({
            query: workspace.query,
            groupIds: workspace.groupIds,
            count: workspace.count,
        });
        workspace.durationMs = performance.now() - startedAt;
        workspace.result = JSON.stringify(result, null, 2);
        workspace.status = 'success';
        updateOperationLog(logId, { response: workspace.result, detail: `Latency: ${formatDurationMs(workspace.durationMs)}` });
        completeOperationLog(logId, 'success');
    } catch (error) {
        workspace.durationMs = performance.now() - startedAt;
        workspace.error = error?.message ?? String(error);
        workspace.status = 'error';
        updateOperationLog(logId, { error: workspace.error, detail: `Latency: ${formatDurationMs(workspace.durationMs)}` });
        completeOperationLog(logId, 'error');
        throw error;
    } finally {
        refreshSceneDirectorPanel();
    }
}

async function testWorldInfoPrompt(caller = 'manual') {
    const ctx = SillyTavern.getContext();

    if (typeof ctx.getWorldInfoPrompt !== 'function') {
        backstageLogger.warn('Test:WorldInfo', 'ctx.getWorldInfoPrompt is unavailable in this SillyTavern build', ctx);
        toastr.error('ctx.getWorldInfoPrompt nao esta disponivel.', 'RP Router');
        return null;
    }

    const chatForWI = buildWorldInfoChat(ctx);
    const globalScanData = buildWorldInfoScanData(ctx);
    const scanPromise = waitForWorldInfoScan(ctx);

    backstageLogger.info('Test:WorldInfo', `Test started by ${caller}`);
    backstageLogger.info('Test:WorldInfo', 'Input', {
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

        backstageLogger.info('Test:WorldInfo', 'WorldInfo result', result);
        backstageLogger.debug('Test:WorldInfo', 'worldInfoBefore', result.worldInfoBefore || '');
        backstageLogger.debug('Test:WorldInfo', 'worldInfoAfter', result.worldInfoAfter || '');
        backstageLogger.debug('Test:WorldInfo', 'worldInfoString', result.worldInfoString || '');
        backstageLogger.debug('Test:WorldInfo', 'worldInfoDepth', result.worldInfoDepth || []);
        backstageLogger.debug('Test:WorldInfo', 'worldInfoExamples', result.worldInfoExamples || []);
        backstageLogger.debug('Test:WorldInfo', 'outletEntries', result.outletEntries || {});
        backstageLogger.debug('Test:WorldInfo', 'WORLDINFO_SCAN_DONE raw', scan);
        backstageLogger.info('Test:WorldInfo', 'Activated entries', activatedEntries);

        toastr.info(`WI dry-run: ${activatedEntries.length} entradas ativadas. Veja o console.`, 'RP Router');
        return { result, scan, activatedEntries };
    } catch (error) {
        backstageLogger.error('Test:WorldInfo', 'Test failed', error);
        toastr.error('Erro no teste de World Info. Veja o console.', 'RP Router');
        return null;
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

function routerPromptUsesTag(tag, template = config.routerPrompt) {
    return new RegExp(`{{\\s*${String(tag ?? '').trim()}\\s*}}`, 'i').test(String(template ?? ''));
}

function buildRouterSystemPrompt(routerContext) {
    return renderTemplate(resolveAgentTagsInText(config.routerPrompt), {
        lastSpeaker: routerContext.lastSpeaker,
        players: routerContext.playerNames,
        recentChat: routerContext.recentChat,
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
            ...(Array.isArray(options.priorHistory) ? options.priorHistory : []),
            {
                role: 'user',
                content: String(options.oocRequest ?? '').trim(),
            },
        ];
    }

    const forcedSpeakerInstruction = buildForcedSpeakerInstruction(options.forcedSpeaker);

    return [
        { role: 'system', content: systemPrompt },
        ...(forcedSpeakerInstruction ? [{ role: 'user', content: forcedSpeakerInstruction }] : []),
        { role: 'user', content: 'Return the Turn Router JSON now.' },
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

async function resolveConnectionInputTokenBudget(profileId, explicitBudget = 0) {
    const configuredBudget = Math.max(0, Number(explicitBudget || 0));
    if (configuredBudget > 0) {
        return {
            budget: configuredBudget,
            source: 'configured',
            maxContext: null,
            maxOutput: null,
        };
    }

    try {
        const service = await getConnService();
        const profile = service.getProfile(profileId);
        const api = service.validateProfile(profile);

        if (api.selected === 'openai' && profile?.preset) {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const preset = getPresetManager('openai')?.getCompletionPresetByName(profile.preset);
            const maxContext = Math.max(0, Number(preset?.openai_max_context || 0));
            const maxOutput = Math.max(0, Number(preset?.openai_max_tokens || 0));

            if (maxContext > 0) {
                return {
                    budget: Math.max(1, maxContext - Math.min(maxOutput, maxContext - 1)),
                    source: 'profile-preset',
                    maxContext,
                    maxOutput,
                };
            }
        }
    } catch (error) {
        backstageLogger.warn('Connection', 'Could not resolve input budget from connection profile', error);
    }

    const context = SillyTavern.getContext();
    const maxContext = Math.max(0, Number(context.maxContext || 0));
    if (maxContext > 0) {
        return {
            budget: maxContext,
            source: 'active-context-fallback',
            maxContext,
            maxOutput: null,
        };
    }

    return {
        budget: 0,
        source: 'unbounded-fallback',
        maxContext: null,
        maxOutput: null,
    };
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

    if (source.length <= 80) {
        return '';
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
    if (next === current) return false;
    target.text = next;
    return true;
}

async function fitContextMessagesToInputBudget(profileId, sourceContext, buildMessagesFn, options = {}) {
    const budgetResult = await resolveConnectionInputTokenBudget(profileId, options.explicitBudget);
    const budget = budgetResult.budget;
    const requestService = await getConnService();
    const workingContext = JSON.parse(JSON.stringify(sourceContext ?? {}));
    const originalChatEntries = Array.isArray(workingContext.recentChatEntries)
        ? [...workingContext.recentChatEntries]
        : (workingContext.recentChat ? [String(workingContext.recentChat)] : []);
    setRecentChatEntries(workingContext, originalChatEntries);
    let messages = buildMessagesFn(workingContext);
    let inputTokens = await estimateRequestInputTokens(profileId, messages, requestService);
    let trimmed = false;

    if (options.trimContext === false || !budget || inputTokens <= budget) {
        return {
            messages,
            context: workingContext,
            inputTokens,
            budget,
            budgetSource: budgetResult.source,
            maxContext: budgetResult.maxContext,
            maxOutput: budgetResult.maxOutput,
            trimmed,
        };
    }

    // Preserve structured context while determining how much recent chat fits.
    setRecentChatEntries(workingContext, []);
    messages = buildMessagesFn(workingContext);
    inputTokens = await estimateRequestInputTokens(profileId, messages, requestService);
    trimmed = originalChatEntries.length > 0;

    const shrinkers = [
        () => shrinkObjectTextField(workingContext.lorebookCatalog, { ratio: 0.25 }),
        () => shrinkObjectTextField(workingContext.lorebookContext, { ratio: 0.2 }),
    ];

    for (const shrink of shrinkers) {
        while (inputTokens > budget && shrink()) {
            trimmed = true;
            messages = buildMessagesFn(workingContext);
            inputTokens = await estimateRequestInputTokens(profileId, messages, requestService);
        }

        if (inputTokens <= budget) break;
    }

    if (inputTokens <= budget && originalChatEntries.length) {
        let low = 0;
        let high = originalChatEntries.length;
        let bestCount = 0;
        let bestMessages = messages;
        let bestTokens = inputTokens;

        while (low <= high) {
            const count = Math.floor((low + high) / 2);
            setRecentChatEntries(workingContext, count > 0 ? originalChatEntries.slice(-count) : []);
            const candidateMessages = buildMessagesFn(workingContext);
            const candidateTokens = await estimateRequestInputTokens(profileId, candidateMessages, requestService);

            if (candidateTokens <= budget) {
                bestCount = count;
                bestMessages = candidateMessages;
                bestTokens = candidateTokens;
                low = count + 1;
            } else {
                high = count - 1;
            }
        }

        setRecentChatEntries(workingContext, bestCount > 0 ? originalChatEntries.slice(-bestCount) : []);
        messages = bestMessages;
        inputTokens = bestTokens;
        trimmed = bestCount < originalChatEntries.length || trimmed;
    }

    return {
        messages,
        context: workingContext,
        inputTokens,
        budget,
        budgetSource: budgetResult.source,
        maxContext: budgetResult.maxContext,
        maxOutput: budgetResult.maxOutput,
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

function parseRouterDecision(text) {
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
            backstageLogger.warn('Router', 'Failed to parse JSON response; using raw text', { error, raw });
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

function createOperationLogId() {
    return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendOperationLog(entry) {
    const normalized = {
        id: String(entry?.id ?? createOperationLogId()),
        kind: String(entry?.kind ?? 'event'),
        agentId: String(entry?.agentId ?? ''),
        step: String(entry?.step ?? 'Event'),
        model: String(entry?.model ?? '-'),
        detail: String(entry?.detail ?? ''),
        status: String(entry?.status ?? 'running'),
        startedAt: entry?.startedAt ? new Date(entry.startedAt) : new Date(),
        completedAt: entry?.completedAt ? new Date(entry.completedAt) : null,
        durationMs: Number.isFinite(Number(entry?.durationMs)) ? Number(entry.durationMs) : null,
        inputTokens: entry?.inputTokens != null && Number.isFinite(Number(entry.inputTokens))
            ? Math.max(0, Number(entry.inputTokens))
            : null,
        context: String(entry?.context ?? ''),
        request: String(entry?.request ?? ''),
        response: String(entry?.response ?? ''),
        reasoning: String(entry?.reasoning ?? ''),
        error: String(entry?.error ?? ''),
    };

    sceneDirectorState = {
        ...sceneDirectorState,
        operationLogs: [
            normalized,
            ...(Array.isArray(sceneDirectorState.operationLogs) ? sceneDirectorState.operationLogs : []),
        ].slice(0, MAX_OPERATION_LOGS),
    };
    refreshSceneDirectorPanel();
    return normalized.id;
}

function updateOperationLog(logId, patch) {
    const cleanId = String(logId ?? '').trim();
    if (!cleanId) return null;

    let updated = null;
    const logs = (Array.isArray(sceneDirectorState.operationLogs) ? sceneDirectorState.operationLogs : [])
        .map(log => {
            if (log.id !== cleanId) return log;
            updated = {
                ...log,
                ...patch,
            };
            return updated;
        });

    if (!updated) return null;

    sceneDirectorState = {
        ...sceneDirectorState,
        operationLogs: logs,
    };
    refreshSceneDirectorPanel();
    return updated;
}

function completeOperationLog(logId, status = 'success', completedAt = new Date()) {
    const cleanId = String(logId ?? '').trim();
    const current = (sceneDirectorState.operationLogs ?? []).find(log => log.id === cleanId);
    if (!current) return null;

    const finishedAt = completedAt instanceof Date ? completedAt : new Date(completedAt);
    const startedAt = current.startedAt ? new Date(current.startedAt) : finishedAt;
    const finalStatus = current.error ? 'error' : status;
    const updated = updateOperationLog(cleanId, {
        status: finalStatus,
        completedAt: finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    });

    if (activeOperationLogIds.get(current.kind) === cleanId) {
        activeOperationLogIds.delete(current.kind);
    }
    return updated;
}

function beginOperationLog(kind, step, detail = '', model = '') {
    const normalizedKind = String(kind ?? '').trim() || 'event';
    const existingId = activeOperationLogIds.get(normalizedKind);
    if (existingId) {
        completeOperationLog(existingId, 'interrupted');
    }

    const id = appendOperationLog({
        kind: normalizedKind,
        step,
        detail,
        model: model || '-',
        status: 'running',
        startedAt: new Date(),
    });
    activeOperationLogIds.set(normalizedKind, id);
    return id;
}

function getActiveOperationLogId(kind) {
    return activeOperationLogIds.get(String(kind ?? '').trim()) ?? '';
}

function updateActiveOperationLog(kind, patch) {
    const id = getActiveOperationLogId(kind);
    return id ? updateOperationLog(id, patch) : null;
}

function appendOperationLogDetail(logId, detail) {
    const cleanDetail = String(detail ?? '').trim();
    const current = (sceneDirectorState.operationLogs ?? []).find(log => log.id === logId);
    if (!current || !cleanDetail) {
        return null;
    }

    return updateOperationLog(logId, {
        detail: current.detail ? `${current.detail}\n\n${cleanDetail}` : cleanDetail,
    });
}

function summarizeCompletionMessagesForLog(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const roleCounts = source.reduce((counts, message) => {
        const role = String(message?.role ?? 'unknown').trim() || 'unknown';
        counts[role] = (counts[role] || 0) + 1;
        return counts;
    }, {});
    const roles = Object.entries(roleCounts)
        .map(([role, count]) => `${role}=${count}`)
        .join(', ') || 'none';

    return {
        total: source.length,
        nonSystem: source.filter(message => message?.role !== 'system').length,
        toolCalls: source.filter(message => Array.isArray(message?.tool_calls) && message.tool_calls.length > 0).length,
        toolResults: source.filter(message => message?.role === 'tool').length,
        roles,
    };
}

function summarizeHostChatForLog(ctx = SillyTavern.getContext()) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const userCount = chat.filter(message => message?.is_user && !message?.is_system).length;
    const characterCount = chat.filter(message => !message?.is_user && !message?.is_system).length;
    const systemCount = chat.filter(message => message?.is_system).length;
    const toolCount = chat.filter(isToolInvocationChatMessage).length;
    const latestToolIndex = chat.findLastIndex(isToolInvocationChatMessage);
    const latestToolMessage = latestToolIndex >= 0 ? chat[latestToolIndex] : null;
    const latestToolInvocations = Array.isArray(latestToolMessage?.extra?.tool_invocations)
        ? latestToolMessage.extra.tool_invocations
        : [];
    const lastMessages = chat
        .slice(-3)
        .map(message => {
            const name = String(message?.name ?? 'Unknown').trim() || 'Unknown';
            const kind = message?.is_system ? 'system' : (message?.is_user ? 'user' : 'character');
            const type = String(message?.extra?.type ?? '').trim();
            const length = String(message?.mes ?? '').length;
            return `${name}/${kind}${type ? `/${type}` : ''}/${length} chars`;
        })
        .join(' | ') || 'none';

    return {
        total: chat.length,
        userCount,
        characterCount,
        systemCount,
        toolCount,
        latestToolIndex,
        latestToolDistanceFromEnd: latestToolIndex >= 0 ? chat.length - 1 - latestToolIndex : null,
        latestToolType: String(latestToolMessage?.extra?.type ?? ''),
        latestToolNames: latestToolInvocations
            .map(invocation => String(invocation?.name ?? invocation?.displayName ?? '').trim())
            .filter(Boolean),
        lastMessages,
    };
}

function formatHostChatSummaryForLog(label, snapshot) {
    return [
        label,
        `Host chat: total=${snapshot.total}, user=${snapshot.userCount}, character=${snapshot.characterCount}, system=${snapshot.systemCount}, tools=${snapshot.toolCount}`,
        `Host chat tail: ${snapshot.lastMessages}`,
    ].join('\n');
}

function formatTriggerSettleForLog(state) {
    if (!state) {
        return 'Profile settle: no snapshot';
    }

    const events = (Array.isArray(state.events) ? state.events : [])
        .slice()
        .reverse()
        .map(event => {
            const name = String(event?.name ?? '').trim() || 'unknown';
            const detail = String(event?.detail ?? '').trim();
            return detail ? `${name} (${detail})` : name;
        })
        .join(' -> ') || 'none';

    return [
        `Profile settle: ${String(state.status ?? 'unknown')}`,
        `Settle anchor: ${state.anchorSeen ? String(state.anchorEventName ?? 'seen') : 'not seen'}`,
        `Settle last event: ${String(state.lastEventName ?? 'none')}`,
        `Settle events: ${events}`,
    ].join('\n');
}

function sanitizeRequestPayloadForLog(value, seen = new WeakSet()) {
    if (value == null || typeof value !== 'object') {
        return value;
    }

    if (seen.has(value)) {
        return '[Circular]';
    }

    seen.add(value);
    if (Array.isArray(value)) {
        return value.map(item => sanitizeRequestPayloadForLog(item, seen));
    }

    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
        if (/^(?:api[_-]?key|authorization|proxy_password|password|secret|access[_-]?token)$/i.test(key)) {
            sanitized[key] = '[REDACTED]';
            continue;
        }

        sanitized[key] = sanitizeRequestPayloadForLog(item, seen);
    }
    return sanitized;
}

function formatCharacterRequestSummary(payload, requestNumber, messageCharacters, tokenMarker) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const roleCounts = messages.reduce((counts, message) => {
        const role = String(message?.role ?? 'unknown').trim() || 'unknown';
        counts[role] = (counts[role] || 0) + 1;
        return counts;
    }, {});
    const roleSummary = Object.entries(roleCounts)
        .map(([role, count]) => `${role}=${count}`)
        .join(', ') || 'none';
    const toolCount = Array.isArray(payload?.tools) ? payload.tools.length : 0;
    const historyToolCalls = messages.filter(message => Array.isArray(message?.tool_calls) && message.tool_calls.length > 0).length;
    const historyToolResults = messages.filter(message => message?.role === 'tool').length;

    return [
        `API request ${requestNumber}`,
        `Messages: ${messages.length} (${roleSummary})`,
        `Message characters: ${messageCharacters}`,
        `Estimated input tokens: ${tokenMarker}`,
        `Model: ${String(payload?.model ?? '-')}`,
        `Source: ${String(payload?.chat_completion_source ?? '-')}`,
        `Max output tokens: ${String(payload?.max_tokens ?? '-')}`,
        `Streaming: ${String(!!payload?.stream)}`,
        `Registered tools: ${toolCount}`,
        `History tool calls: ${historyToolCalls}`,
        `History tool results: ${historyToolResults}`,
    ].join('\n');
}

function replaceCharacterRequestTokenMarker(operationLogId, tokenMarker, value, requestNumber = null) {
    const latest = (sceneDirectorState.operationLogs ?? []).find(log => log.id === operationLogId);
    if (!latest || !String(latest.detail ?? '').includes(tokenMarker)) {
        return;
    }

    const patch = {
        detail: String(latest.detail).replace(tokenMarker, String(value)),
    };
    const numericValue = Number(value);
    if (requestNumber != null && Number.isFinite(numericValue) && numericValue >= 0) {
        const requestInputTokens = {
            ...(latest.requestInputTokens ?? {}),
            [requestNumber]: numericValue,
        };
        patch.requestInputTokens = requestInputTokens;
        patch.inputTokens = Object.values(requestInputTokens)
            .reduce((total, tokens) => total + Math.max(0, Number(tokens) || 0), 0);
    }

    updateOperationLog(operationLogId, patch);
}

function captureCharacterApiRequest(payload) {
    const operationLogId = getActiveOperationLogId('character-turn');
    if (!operationLogId || !payload || typeof payload !== 'object') {
        return;
    }

    const current = (sceneDirectorState.operationLogs ?? []).find(log => log.id === operationLogId);
    if (!current) {
        return;
    }

    const requestNumber = Math.max(0, Number(current.requestCount) || 0) + 1;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const serializedMessages = JSON.stringify(messages);
    const messageCharacters = serializedMessages.length;
    const tokenMarker = `[calculating request ${requestNumber}]`;
    const sanitizedPayload = sanitizeRequestPayloadForLog(payload);
    const serializedPayload = JSON.stringify(sanitizedPayload, null, 2);
    const requestBlock = `# Character API Request ${requestNumber}\n${serializedPayload}`;
    const summaryBlock = formatCharacterRequestSummary(payload, requestNumber, messageCharacters, tokenMarker);

    updateOperationLog(operationLogId, {
        model: String(payload.model ?? current.model ?? '-'),
        requestCount: requestNumber,
        request: current.request ? `${current.request}\n\n${requestBlock}` : requestBlock,
        detail: current.detail ? `${current.detail}\n\n${summaryBlock}` : summaryBlock,
    });

    let tokenCountPromise;
    try {
        tokenCountPromise = SillyTavern.getContext().getTokenCountAsync(serializedMessages);
    } catch (error) {
        replaceCharacterRequestTokenMarker(
            operationLogId,
            tokenMarker,
            `unavailable (${error?.message ?? String(error)})`,
        );
        return;
    }

    Promise.resolve(tokenCountPromise)
        .then(tokenCount => {
            replaceCharacterRequestTokenMarker(operationLogId, tokenMarker, tokenCount, requestNumber);
        })
        .catch(error => {
            replaceCharacterRequestTokenMarker(
                operationLogId,
                tokenMarker,
                `unavailable (${error?.message ?? String(error)})`,
            );
        });
}

function resolveIssueOperationKind(source) {
    const normalized = String(source ?? '').trim().toLowerCase();
    if (normalized.includes('router ooc')) return 'router-ooc';
    if (normalized.includes('router')) return 'router-request';
    if (normalized.includes('direct ooc') || normalized.includes('character')) return 'character-turn';
    return '';
}

function recordBackstageIssue(source, message) {
    const issueSource = String(source ?? '').trim();
    const issueMessage = String(message ?? '').trim();
    const operationKind = resolveIssueOperationKind(issueSource);
    const operationLogId = getActiveOperationLogId(operationKind);

    if (operationLogId) {
        updateOperationLog(operationLogId, {
            status: 'error',
            error: issueMessage,
        });
    } else {
        const now = new Date();
        appendOperationLog({
            kind: operationKind || 'error',
            step: issueSource || 'Error',
            status: 'error',
            startedAt: now,
            completedAt: now,
            durationMs: 0,
            error: issueMessage,
        });
    }

    sceneDirectorState = {
        ...sceneDirectorState,
        persistentIssue: issueMessage,
        persistentIssueSource: issueSource,
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

function clearBackstageIssueIfSource(source) {
    if (sceneDirectorState.persistentIssueSource === source) clearBackstageIssue();
}

function cloneRuntimeTiming() {
    const current = sceneDirectorState.runtimeTiming ?? {};
    return {
        activeKind: String(current.activeKind ?? ''),
        activeLabel: String(current.activeLabel ?? ''),
        activeStartedAt: current.activeStartedAt ? new Date(current.activeStartedAt) : null,
        activeDetail: String(current.activeDetail ?? ''),
        activeModel: String(current.activeModel ?? ''),
        lastCompletedKind: String(current.lastCompletedKind ?? ''),
        lastCompletedLabel: String(current.lastCompletedLabel ?? ''),
        lastCompletedMs: Number.isFinite(Number(current.lastCompletedMs)) ? Number(current.lastCompletedMs) : null,
        lastCompletedAt: current.lastCompletedAt ? new Date(current.lastCompletedAt) : null,
        lastRouterMs: Number.isFinite(Number(current.lastRouterMs)) ? Number(current.lastRouterMs) : null,
        lastRouterAt: current.lastRouterAt ? new Date(current.lastRouterAt) : null,
        lastRouterModel: String(current.lastRouterModel ?? ''),
        lastCharacterMs: Number.isFinite(Number(current.lastCharacterMs)) ? Number(current.lastCharacterMs) : null,
        lastCharacterAt: current.lastCharacterAt ? new Date(current.lastCharacterAt) : null,
        lastCharacterModel: String(current.lastCharacterModel ?? ''),
    };
}

function getConnectionProfile(profileId, ctx = SillyTavern.getContext()) {
    const cleanId = String(profileId ?? '').trim();
    if (!cleanId) {
        return null;
    }

    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    return profiles.find(profile => String(profile?.id ?? '') === cleanId) ?? null;
}

function getTimingModelLabel(profileId, fallbackName = '', ctx = SillyTavern.getContext()) {
    const profile = getConnectionProfile(profileId, ctx);
    const model = String(profile?.model ?? '').trim();
    const name = String(profile?.name ?? '').trim();
    const fallback = String(fallbackName ?? '').trim();
    return model || name || fallback || '-';
}

function beginRuntimePhase(kind, label, detail = '', model = '') {
    const current = cloneRuntimeTiming();
    const now = new Date();
    beginOperationLog(kind, label, detail, model);

    sceneDirectorState = {
        ...sceneDirectorState,
        runtimeTiming: {
            ...current,
            activeKind: String(kind ?? '').trim(),
            activeLabel: String(label ?? '').trim(),
            activeStartedAt: now,
            activeDetail: String(detail ?? '').trim(),
            activeModel: String(model ?? '').trim(),
        },
    };
    refreshSceneDirectorPanel();
}

function finishRuntimePhase(expectedKinds = null, status = 'success') {
    const current = cloneRuntimeTiming();
    const fallbackKind = Array.isArray(expectedKinds)
        ? expectedKinds.find(kind => getActiveOperationLogId(kind))
        : '';

    if (!current.activeKind || !current.activeStartedAt) {
        if (fallbackKind) {
            completeOperationLog(getActiveOperationLogId(fallbackKind), status);
        }
        return;
    }

    if (Array.isArray(expectedKinds) && expectedKinds.length && !expectedKinds.includes(current.activeKind)) {
        if (fallbackKind) {
            completeOperationLog(getActiveOperationLogId(fallbackKind), status);
        }
        return;
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - current.activeStartedAt.getTime());
    const nextTiming = {
        ...current,
        activeKind: '',
        activeLabel: '',
        activeStartedAt: null,
        activeDetail: '',
        activeModel: '',
        lastCompletedKind: current.activeKind,
        lastCompletedLabel: current.activeLabel,
        lastCompletedMs: durationMs,
        lastCompletedAt: finishedAt,
    };

    if (current.activeKind === 'router-request' || current.activeKind === 'router-ooc') {
        nextTiming.lastRouterMs = durationMs;
        nextTiming.lastRouterAt = finishedAt;
        nextTiming.lastRouterModel = current.activeModel;
    }

    if (current.activeKind === 'character-turn') {
        nextTiming.lastCharacterMs = durationMs;
        nextTiming.lastCharacterAt = finishedAt;
        nextTiming.lastCharacterModel = current.activeModel;
    }

    sceneDirectorState = {
        ...sceneDirectorState,
        runtimeTiming: nextTiming,
    };
    refreshSceneDirectorPanel();
    completeOperationLog(getActiveOperationLogId(current.activeKind), status, finishedAt);
}

async function withContextSnapshotLock(operation) {
    const previous = contextSnapshotQueue;
    let release;
    contextSnapshotQueue = new Promise(resolve => {
        release = resolve;
    });

    await previous.catch(() => {});
    try {
        return await operation();
    } finally {
        release();
    }
}

function getChatContextKey(ctx = SillyTavern.getContext()) {
    return [
        String(ctx?.groupId ?? ctx?.characterId ?? ''),
        String(ctx?.chatId ?? ''),
    ].join(':');
}

function cloneRouterRequestPayload(payload) {
    return JSON.parse(JSON.stringify(payload));
}

function getSceneDirectorMetadata(ctx = SillyTavern.getContext()) {
    ctx.chatMetadata.sceneDirector ??= {};
    return ctx.chatMetadata.sceneDirector;
}

function getAgentDefinition(agentId) {
    const cleanId = normalizeAgentId(agentId);
    return (Array.isArray(config.agents) ? config.agents : [])
        .find(agent => normalizeAgentId(agent?.id) === cleanId) ?? null;
}

function getAgentMetadata(ctx = SillyTavern.getContext()) {
    const metadata = getSceneDirectorMetadata(ctx);
    metadata.agents ??= {};
    return metadata.agents;
}

function getAgentRuntimeState(agentId, ctx = SillyTavern.getContext()) {
    const cleanId = normalizeAgentId(agentId);
    const agents = getAgentMetadata(ctx);
    const current = agents[cleanId] && typeof agents[cleanId] === 'object' ? agents[cleanId] : {};
    return {
        output: String(current.output ?? ''),
        updatedAt: String(current.updatedAt ?? ''),
        runId: String(current.runId ?? ''),
        lastStatus: String(current.lastStatus ?? 'idle'),
        lastError: String(current.lastError ?? ''),
        pendingTurns: Math.max(0, Number(current.pendingTurns) || 0),
        lastTrigger: String(current.lastTrigger ?? ''),
        snapshots: (Array.isArray(current.snapshots) ? current.snapshots : [])
            .map(normalizePersistedSnapshot)
            .filter(Boolean)
            .slice(0, AGENT_OUTPUT_SNAPSHOT_RETENTION),
        lastSnapshotAt: String(current.lastSnapshotAt ?? ''),
        lastActionStatus: String(current.lastActionStatus ?? 'idle'),
        lastActionResult: String(current.lastActionResult ?? ''),
        lastActionError: String(current.lastActionError ?? ''),
        lastActionPayload: String(current.lastActionPayload ?? ''),
        lastActionLogs: String(current.lastActionLogs ?? ''),
        lastActionTrigger: String(current.lastActionTrigger ?? ''),
        lastActionExecutedAt: String(current.lastActionExecutedAt ?? ''),
        lastActionDurationMs: Math.max(0, Number(current.lastActionDurationMs) || 0),
    };
}

function saveAgentRuntimeState(agentId, patch, ctx = SillyTavern.getContext()) {
    const cleanId = normalizeAgentId(agentId);
    if (!cleanId) return null;

    const agents = getAgentMetadata(ctx);
    agents[cleanId] = {
        ...getAgentRuntimeState(cleanId, ctx),
        ...patch,
    };
    ctx.saveMetadata?.();
    return agents[cleanId];
}

function getAgentDependencies(template) {
    const dependencies = [];
    const pattern = /{{\s*agent:([a-zA-Z0-9_:-]+)\s*}}/gi;
    let match;
    while ((match = pattern.exec(String(template ?? ''))) !== null) {
        const id = normalizeAgentId(match[1]);
        if (id && !dependencies.includes(id)) dependencies.push(id);
    }
    return dependencies;
}

function getAgentOutputSnapshot(agentId, ctx = SillyTavern.getContext()) {
    const definition = getAgentDefinition(agentId);
    const runtime = getAgentRuntimeState(agentId, ctx);
    return {
        id: normalizeAgentId(agentId),
        name: definition?.name || agentId,
        output: runtime.output,
        runId: runtime.runId,
        updatedAt: runtime.updatedAt,
    };
}

function resolveCharacterByName(referenceName, ctx = SillyTavern.getContext()) {
    const query = String(referenceName ?? '').trim().toLowerCase();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    if (!query) return { character: null, status: 'empty' };

    const exactMatches = characters.filter(character => String(character?.name ?? '').trim().toLowerCase() === query);
    if (exactMatches.length === 1) return { character: exactMatches[0], status: 'exact' };
    if (exactMatches.length > 1) return { character: null, status: 'ambiguous' };

    const firstNameMatches = characters.filter(character => {
        const firstName = String(character?.name ?? '').trim().toLowerCase().split(/\s+/)[0];
        return firstName === query;
    });
    if (firstNameMatches.length === 1) return { character: firstNameMatches[0], status: 'first-name' };
    if (firstNameMatches.length > 1) return { character: null, status: 'ambiguous' };
    return { character: null, status: 'not-found' };
}

function getCharacterPersonalityTagReferences(template, ctx = SillyTavern.getContext()) {
    const references = [];
    const seen = new Set();
    const pattern = /{{\s*characterPersonality\s*:\s*([^{}]+?)\s*}}/gi;
    let match;

    while ((match = pattern.exec(String(template ?? ''))) !== null) {
        const query = String(match[1] ?? '').trim();
        const key = query.toLowerCase();
        if (!query || seen.has(key)) continue;
        seen.add(key);
        const resolved = resolveCharacterByName(query, ctx);
        references.push({
            query,
            status: resolved.status,
            name: String(resolved.character?.name ?? ''),
            avatar: String(resolved.character?.avatar ?? ''),
            personality: getCharacterCardValue(resolved.character, 'personality'),
        });
    }

    return references;
}

function resolveAgentTagsInText(template, ctx = SillyTavern.getContext(), snapshots = null) {
    const values = snapshots instanceof Map ? snapshots : null;
    const withAgentOutputs = String(template ?? '').replace(/{{\s*agent:([a-zA-Z0-9_:-]+)\s*}}/gi, (_match, rawId) => {
        const id = normalizeAgentId(rawId);
        const snapshot = values?.get(id) ?? getAgentOutputSnapshot(id, ctx);
        return snapshot?.output?.trim() || `[No output available for agent:${id}]`;
    });

    return withAgentOutputs.replace(/{{\s*characterPersonality\s*:\s*([^{}]+?)\s*}}/gi, (_match, rawName) => {
        const query = String(rawName ?? '').trim();
        const resolved = resolveCharacterByName(query, ctx);
        if (!resolved.character) {
            return resolved.status === 'ambiguous'
                ? `[Character personality reference is ambiguous: ${query}]`
                : `[Character personality not found: ${query}]`;
        }

        return getCharacterCardValue(resolved.character, 'personality')
            || `[Character personality not provided: ${resolved.character.name || query}]`;
    });
}

function getAgentReferenceCharacter(agent, ctx = SillyTavern.getContext()) {
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    if (agent?.ownerType === AGENT_OWNER_TYPES.CHARACTER) {
        return findCharacterConnection(agent, characters);
    }
    const avatar = String(agent?.referenceCharacterAvatar ?? '');
    const name = String(agent?.referenceCharacterName ?? '').trim();

    return characters.find(character => String(character?.avatar ?? '') === avatar)
        ?? characters.find(character => String(character?.name ?? '').trim().toLowerCase() === name.toLowerCase())
        ?? null;
}

function getCharacterCardValue(character, ...fieldNames) {
    const data = character?.data ?? character ?? {};
    for (const fieldName of fieldNames) {
        const value = data[fieldName] ?? character?.[fieldName];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function getAgentCharacterReference(agent, ctx = SillyTavern.getContext()) {
    const character = getAgentReferenceCharacter(agent, ctx);
    const owned = agent?.ownerType === AGENT_OWNER_TYPES.CHARACTER;
    return {
        name: String(character?.name ?? (owned ? agent.ownerCharacterName : agent?.referenceCharacterName) ?? '').trim(),
        avatar: String(character?.avatar ?? (owned ? agent.ownerCharacterAvatar : agent?.referenceCharacterAvatar) ?? ''),
        personality: getCharacterCardValue(character, 'personality'),
        scenario: getCharacterCardValue(character, 'scenario'),
        creatorNotes: getCharacterCardValue(character, 'creator_notes', 'creatorcomment'),
    };
}

async function buildAgentContextSnapshot(agent, trigger, ctx = SillyTavern.getContext()) {
    const realMessages = getRpContextMessages(ctx.chat, agent.includeHiddenMessages, agent.contextMessageOffset);
    const creationInput = agent.internalType === SUMMARY_CREATION_TYPE && trigger?.type !== 'ooc'
        ? summaryCreation.prepare(agent, ctx) : null;
    const recentMessages = creationInput ? creationInput.entries.map(entry => entry.message) : realMessages.slice(-agent.contextMessages);
    const recentChatEntries = formatAgentRpContext(agent, recentMessages, ctx, !!creationInput);
    const ownerCharacterName = agent.ownerType === AGENT_OWNER_TYPES.CHARACTER
        ? (findCharacterConnection(agent, config.characters)?.name || agent.ownerCharacterName)
        : '';
    const dependencies = getAgentDependencies(agent.prompt);
    const dependencySnapshots = new Map(
        dependencies.map(id => [id, getAgentOutputSnapshot(id, ctx)]),
    );
    const characterReference = getAgentCharacterReference(agent, ctx);
    const summaryOwner = agent.ownerType === AGENT_OWNER_TYPES.CHARACTER
        ? findCharacterConnection(agent, config.characters) : null;
    const characterSummary = summaryOwner ? buildSummaryInjection(ctx, summaryOwner)?.prompt ?? '' : '';
    const characterPersonalityReferences = getCharacterPersonalityTagReferences(agent.prompt, ctx);
    const [lorebookContext, lorebookCatalog] = await Promise.all([
        routerPromptUsesTag('lorebookContext', agent.prompt)
            ? getSelectedWorldInfoContext(ctx, agent.worldInfoBooks)
            : Promise.resolve({
                text: '',
                source: 'agent-template-tag-not-used',
                selectedBooks: [],
                activatedEntries: [],
                length: 0,
            }),
        routerPromptUsesTag('lorebookCatalog', agent.prompt)
            ? getSelectedWorldInfoCatalog(agent.worldInfoBooks, { fullContent: true })
            : Promise.resolve({
                text: '',
                source: 'agent-template-tag-not-used',
                selectedBooks: [],
                entryCount: 0,
            }),
    ]);

    return {
        agentId: agent.id,
        agentName: agent.name,
        applyPromptRegex: agent.applyPromptRegex === true,
        contextMessageOffset: normalizeContextMessageOffset(agent.contextMessageOffset),
        promptTemplate: creationInput ? `Memory owner: ${creationInput.character.name}\n\n${agent.prompt}` : agent.prompt,
        creationInput,
        previousOutput: getAgentRuntimeState(agent.id, ctx).output,
        ownerCharacterName,
        recentChatEntries,
        recentChat: recentChatEntries.join('\n'),
        humanName: String(ctx.name1 ?? ''),
        lastSpeaker: String(realMessages[realMessages.length - 1]?.name ?? 'Unknown'),
        trigger: String(trigger?.label ?? trigger?.type ?? 'manual'),
        dependencies: Object.fromEntries(dependencySnapshots),
        characterReference,
        characterSummary,
        characterPersonalityReferences,
        lorebookContext,
        lorebookCatalog,
    };
}

function buildAgentMessages(agentContext, options = {}) {
    const dependencySnapshots = new Map(Object.entries(agentContext.dependencies ?? {}));
    const withAgentOutputs = resolveAgentTagsInText(agentContext.promptTemplate, SillyTavern.getContext(), dependencySnapshots);
    const templateUsesPreviousOutput = routerPromptUsesTag('previousOutput', agentContext.promptTemplate);
    const systemPrompt = renderTemplate(withAgentOutputs, {
        recentChat: agentContext.recentChat,
        recentCharChat: agentContext.recentCharChat || '[No recent messages from the agent owner]',
        previousOutput: agentContext.previousOutput || '[No previous output]',
        user: agentContext.humanName,
        lastSpeaker: agentContext.lastSpeaker,
        trigger: agentContext.trigger,
        characterPersonality: agentContext.characterReference?.personality || '[Character personality not provided]',
        characterScenario: agentContext.characterReference?.scenario || '[Character scenario not provided]',
        characterCreatorNotes: agentContext.characterReference?.creatorNotes || '[Character creator notes not provided]',
        characterSummary: agentContext.characterSummary || '[No character summary selected for injection]',
        lorebookContext: agentContext.lorebookContext?.text || '[No activated lorebook context]',
        lorebookCatalog: agentContext.lorebookCatalog?.text || '[No selected lorebook catalog]',
    });
    if (options.mode === 'ooc') {
        const persistedOutputMessage = templateUsesPreviousOutput
            ? []
            : [{
                role: 'system',
                content: `[PERSISTED_AGENT_OUTPUT]
This is the agent's current persisted output. Use it as existing working state when answering the operator.

${agentContext.previousOutput || '[No previous output]'}
[/PERSISTED_AGENT_OUTPUT]`,
            }];
        return [
            { role: 'system', content: systemPrompt },
            ...persistedOutputMessage,
            {
                role: 'system',
                content: 'Agent workspace mode. Respond directly to the operator in OOC. Do not replace the agent persistent output unless the operator explicitly asks you to draft a replacement. Do not narrate in-character prose.',
            },
            ...(Array.isArray(options.priorHistory) ? options.priorHistory : []),
            { role: 'user', content: String(options.oocRequest ?? '').trim() },
        ];
    }

    return [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: 'Run your assigned task now. Return only the complete updated output for this agent.',
        },
    ];
}

function formatAgentContextForLog(agentContext) {
    return JSON.stringify({
        agent: {
            id: agentContext.agentId,
            name: agentContext.agentName,
        },
        trigger: agentContext.trigger,
        user: agentContext.humanName,
        lastSpeaker: agentContext.lastSpeaker,
        recentChatMessages: agentContext.recentChatEntries?.length ?? 0,
        applyPromptRegex: agentContext.applyPromptRegex,
        contextMessageOffset: agentContext.contextMessageOffset,
        recentCharacterMessages: agentContext.recentCharChatEntries?.length ?? 0,
        ownerCharacterName: agentContext.ownerCharacterName,
        characterSummary: agentContext.characterSummary,
        previousOutput: agentContext.previousOutput,
        dependencies: agentContext.dependencies,
        characterReference: agentContext.characterReference,
        characterPersonalityReferences: agentContext.characterPersonalityReferences,
        lorebookContext: agentContext.lorebookContext,
        lorebookCatalog: agentContext.lorebookCatalog,
    }, null, 2);
}

function getLatestAgentOperation(agentId) {
    const cleanId = normalizeAgentId(agentId);
    return (sceneDirectorState.operationLogs ?? [])
        .find(log => log.agentId === cleanId && log.kind === `agent:${cleanId}`) ?? null;
}

function sortScheduledAgents(agentIds) {
    const due = new Set(agentIds.map(normalizeAgentId));
    const visiting = new Set();
    const visited = new Set();
    const result = [];

    const visit = id => {
        if (visited.has(id)) return;
        if (visiting.has(id)) {
            throw new Error(`Circular agent dependency detected at agent:${id}.`);
        }

        visiting.add(id);
        const agent = getAgentDefinition(id);
        for (const dependency of getAgentDependencies(agent?.prompt)) {
            if (getAgentDefinition(dependency)) visit(dependency);
        }
        visiting.delete(id);
        visited.add(id);
        if (due.has(id)) result.push(id);
    };

    for (const id of due) visit(id);
    return result;
}

function agentScheduleMatchesEvent(agent, event) {
    if (!agent.enabled || agent.scheduleType === 'manual') return false;
    if (agent.scheduleType === 'user-turns') return event.type === 'user';
    if (agent.scheduleType === 'total-turns') return event.type === 'user' || event.type === 'character';
    if (agent.scheduleType !== 'character-turns' || event.type !== 'character') return false;

    const target = String(agent.ownerType === AGENT_OWNER_TYPES.CHARACTER
        ? getAgentOwnerLabel(agent)
        : agent.characterName ?? '').trim().toLocaleLowerCase();
    const speaker = String(event.characterName ?? '').trim().toLocaleLowerCase();
    if (!target || !speaker) return false;
    return target === speaker || target.split(/\s+/)[0] === speaker.split(/\s+/)[0];
}

function formatAgentActionTrigger(trigger) {
    const type = String(trigger?.type ?? 'manual').trim() || 'manual';
    const label = String(trigger?.label ?? '').trim();
    return label || type;
}

async function executeConfiguredAgentAction(agent, rawOutput, trigger, ctx = SillyTavern.getContext()) {
    if (!agent?.actionEnabled) {
        throw new Error(`JavaScript actions are disabled for ${agent?.name || 'this agent'}.`);
    }
    if (runningAgentActionIds.has(agent.id)) {
        throw new Error(`${agent.name} already has a JavaScript action running.`);
    }

    const triggerLabel = formatAgentActionTrigger(trigger);
    const operationName = getAgentOperationDisplayName(agent);
    const operationKind = `agent-action:${agent.id}`;
    const logScope = getAgentLogScope(agent);
    const logId = beginOperationLog(operationKind, `Agent action: ${operationName}`, triggerLabel, 'Browser JavaScript');
    updateOperationLog(logId, {
        agentId: agent.id,
        context: String(agent.actionScript ?? ''),
        request: String(rawOutput ?? ''),
    });
    runningAgentActionIds.add(agent.id);
    saveAgentRuntimeState(agent.id, {
        lastActionStatus: 'running',
        lastActionError: '',
        lastActionTrigger: triggerLabel,
    }, ctx);
    refreshSceneDirectorPanel();

    try {
        const execution = await executeAgentAction({
            script: agent.actionScript,
            rawOutput,
            agent: Object.freeze({ ...agent }),
            trigger: Object.freeze({ ...trigger, label: triggerLabel }),
            context: ctx,
            onLog: line => backstageLogger.debug(logScope, `Action: ${line}`),
        });
        const executedAt = new Date().toISOString();
        const actionLogs = execution.logs.join('\n');
        saveAgentRuntimeState(agent.id, {
            lastActionStatus: 'success',
            lastActionResult: execution.resultText,
            lastActionError: '',
            lastActionPayload: execution.payloadText,
            lastActionLogs: actionLogs,
            lastActionTrigger: triggerLabel,
            lastActionExecutedAt: executedAt,
            lastActionDurationMs: execution.durationMs,
        }, ctx);
        updateOperationLog(logId, {
            response: execution.resultText,
            detail: [
                `Trigger: ${triggerLabel}`,
                `Duration: ${formatDurationMs(execution.durationMs)}`,
                actionLogs ? `Script logs:\n${actionLogs}` : 'Script logs: none',
            ].join('\n'),
        });
        completeOperationLog(logId, 'success');
        clearBackstageIssueIfSource(`Agent action: ${operationName}`);
        backstageLogger.info(logScope, 'Action completed', {
            trigger: triggerLabel,
            durationMs: execution.durationMs,
        });
        return execution;
    } catch (error) {
        const stage = String(error?.stage ?? 'runtime');
        const message = error?.message ?? String(error);
        const detail = error?.stack ? `${message}\n\n${error.stack}` : message;
        saveAgentRuntimeState(agent.id, {
            lastActionStatus: 'error',
            lastActionResult: '',
            lastActionError: message,
            lastActionPayload: String(rawOutput ?? ''),
            lastActionLogs: '',
            lastActionTrigger: triggerLabel,
            lastActionExecutedAt: new Date().toISOString(),
            lastActionDurationMs: 0,
        }, ctx);
        updateOperationLog(logId, {
            error: `[${stage}] ${detail}`,
            detail: `Trigger: ${triggerLabel}\nFailure stage: ${stage}`,
        });
        completeOperationLog(logId, 'error');
        backstageLogger.error(logScope, `Action failed at ${stage}`, error);
        sceneDirectorState = {
            ...sceneDirectorState,
            persistentIssue: message,
            persistentIssueSource: `Agent action: ${operationName}`,
            persistentIssueAt: new Date(),
        };
        refreshSceneDirectorPanel();
        throw error;
    } finally {
        runningAgentActionIds.delete(agent.id);
        refreshSceneDirectorPanel();
    }
}

async function executeAgent(agentId, trigger = { type: 'manual', label: 'Manual run' }) {
    const agent = getAgentDefinition(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (runningAgentIds.has(agent.id)) return null;

    const ctx = SillyTavern.getContext();
    const originChatKey = getChatContextKey(ctx);
    const operationKind = `agent:${agent.id}`;
    const operationName = getAgentOperationDisplayName(agent);
    const logScope = getAgentLogScope(agent);
    const connection = resolveAgentConnection(agent, config);
    const model = getTimingModelLabel(connection.profileId, connection.profileName);
    const logId = beginOperationLog(operationKind, `Agent: ${operationName}`, trigger.label || trigger.type, model);
    updateOperationLog(logId, { agentId: agent.id });
    const cancellation = cancellableOperations.start(`agent:${agent.id}`, {
        logId,
        mode: 'run',
        agentId: agent.id,
    });
    let rawOutput = '';
    runningAgentIds.add(agent.id);
    saveAgentRuntimeState(agent.id, {
        lastStatus: 'running',
        lastError: '',
        lastTrigger: trigger.label || trigger.type,
    }, ctx);
    refreshSceneDirectorPanel();
    backstageLogger.info(logScope, 'Execution started', {
        trigger: trigger.label || trigger.type,
        profile: connection.profileName || connection.profileId || 'not configured',
        connectionSource: connection.source,
    });

    try {
        if (agent.internalType === SUMMARY_CREATION_TYPE && trigger.type === 'retry-save') {
            const registered = await summaryCreation.retry(agent, ctx, cancellation.controller.signal);
            saveAgentRuntimeState(agent.id, { output: registered.output, lastStatus: 'success', lastError: '',
                updatedAt: new Date().toISOString() }, ctx);
            appendOperationLogDetail(logId, `MemoryBox retry: ${registered.saved.length} memories saved.`);
            await refreshSummaryAfterCreation(agent, ctx, logId, cancellation.controller.signal);
            completeOperationLog(logId, 'success');
            clearBackstageIssueIfSource(`Agent: ${operationName}`);
            return registered.output;
        }
        if (!connection.profileId) throw new Error(`Agent ${agent.name} has no resolved Connection Profile (${connection.label}).`);
        if (!agent.prompt.trim()) throw new Error(`Agent ${agent.name} has an empty prompt.`);
        cancellableOperations.assertActive(cancellation);
        sortScheduledAgents([agent.id]);

        const agentContext = await buildAgentContextSnapshot(agent, trigger, ctx);
        cancellableOperations.assertActive(cancellation);
        const budgetedRequest = await fitContextMessagesToInputBudget(
            connection.profileId,
            agentContext,
            buildAgentMessages,
        );
        cancellableOperations.assertActive(cancellation);
        if (agentContext.creationInput && budgetedRequest.trimmed) {
            throw new Error('Memory creation input exceeds the connection budget. Reduce recent messages; no memories were saved.');
        }
        const messages = budgetedRequest.messages;
        updateOperationLog(logId, {
            context: formatAgentContextForLog(budgetedRequest.context),
            request: formatPromptMessages(messages),
            inputTokens: budgetedRequest.inputTokens,
            detail: [
                `Trigger: ${trigger.label || trigger.type}`,
                `Profile: ${connection.profileName || connection.profileId}`,
                `Connection source: ${connection.label}`,
                `Dependencies: ${getAgentDependencies(agent.prompt).map(id => `agent:${id}`).join(', ') || 'none'}`,
                `Lorebooks: ${(agent.worldInfoBooks ?? []).join(', ') || 'none'}`,
                `Recent RP messages: ${budgetedRequest.context?.recentChatEntries?.length ?? 0}`,
                `Recent owner messages: ${budgetedRequest.context?.recentCharChatEntries?.length ?? 0}`,
                `Output validation: ${agent.validateOutputFormat ? 'enabled' : 'disabled'}`,
                `JavaScript action: ${agent.actionEnabled ? (agent.actionAutoRun ? 'enabled, automatic' : 'enabled, manual') : 'disabled'}`,
                `Character injection targets: ${getAgentInjectionTargets(agent).map(target => `${target.characterName}:${target.mode}${target.mode === 'tag' ? `:<${target.tag}>` : ''}`).join(', ') || 'none'}`,
                `Character injection placement: ${formatAgentInjectionPlacement(agent)}`,
                `Tool-call round limit: ${agent.maxToolRounds}`,
                `Input budget: ${budgetedRequest.budget}`,
                `Input trimmed: ${budgetedRequest.trimmed}`,
            ].join('\n'),
        });
        backstageLogger.debug(logScope, 'Request context prepared', {
            inputTokens: budgetedRequest.inputTokens,
            inputBudget: budgetedRequest.budget,
            trimmed: budgetedRequest.trimmed,
            recentMessages: budgetedRequest.context?.recentChatEntries?.length ?? 0,
            connectionSource: connection.source,
            lorebooks: agent.worldInfoBooks ?? [],
        });

        const automaticToolRuntime = buildAgentGraphitiToolRuntime(agent, 'automatic');
        if (automaticToolRuntime) {
            appendOperationLogDetail(logId, `Long-term memory tools: ${automaticToolRuntime.summary}`);
        }
        const response = automaticToolRuntime
            ? await sendAgentToolRequest(connection.profileId, messages, logId, automaticToolRuntime, agent.maxToolRounds, cancellation.controller.signal)
            : await sendAgentStreamingRequest(connection.profileId, messages, cancellation.controller.signal);
        cancellableOperations.assertActive(cancellation);
        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? '';
        rawOutput = extractResponseText(response);
        const responseText = stripMarkdownFence(rawOutput);
        updateOperationLog(logId, {
            response: responseText,
            reasoning: String(reasoning ?? ''),
        });
        if (!responseText) throw new Error(`Agent ${agent.name} returned an empty output.`);
        const outputValidation = validateAgentOutput(agent, responseText);
        if (!outputValidation.valid) {
            throw new Error(`${agent.name} output was rejected: ${outputValidation.error}`);
        }
        const completionCtx = SillyTavern.getContext();
        if (getChatContextKey(completionCtx) !== originChatKey) {
            throw new Error(`Chat changed while agent ${agent.name} was running. Output was not saved.`);
        }
        if (agentContext.creationInput) {
            const registered = await summaryCreation.save(agent, responseText, agentContext.creationInput,
                completionCtx, cancellation.controller.signal);
            appendOperationLogDetail(logId, `MemoryBox: ${registered.saved.length} memories saved.`);
            await refreshSummaryAfterCreation(agent, completionCtx, logId, cancellation.controller.signal);
        }

        const currentRuntime = getAgentRuntimeState(agent.id, completionCtx);
        const consumedTurns = trigger.type === 'before-character'
            ? 0
            : trigger.type === 'manual'
            ? currentRuntime.pendingTurns
            : Math.max(1, Number(trigger.consumedTurns) || agent.interval);
        const runId = `agent-run-${Date.now()}-${agent.id}`;
        cancellableOperations.assertActive(cancellation);
        try {
            const snapshot = await maybePersistAgentOutputSnapshot(
                agent.id,
                responseText,
                completionCtx,
                cancellation.controller.signal,
            );
            if (snapshot) {
                appendOperationLogDetail(logId, `Agent output snapshot saved: ${snapshot.fileName}`);
            }
        } catch (snapshotError) {
            if (isAbortError(snapshotError) || cancellation.controller.signal.aborted) throw snapshotError;
            const snapshotMessage = snapshotError?.message ?? String(snapshotError);
            backstageLogger.error(logScope, 'Output updated, but snapshot persistence failed', snapshotError);
            appendOperationLogDetail(logId, `Agent output snapshot failed: ${snapshotMessage}`);
            toastr.warning(`${agent.name} updated, but its snapshot was not saved.`, EXTENSION_LABEL);
        }
        cancellableOperations.assertActive(cancellation);
        saveAgentRuntimeState(agent.id, {
            output: responseText,
            updatedAt: new Date().toISOString(),
            runId,
            lastStatus: 'success',
            lastError: '',
            lastTrigger: trigger.label || trigger.type,
            pendingTurns: Math.max(0, currentRuntime.pendingTurns - consumedTurns),
        }, completionCtx);
        updateOperationLog(logId, {
            runId,
        });
        if (agent.actionEnabled && agent.actionAutoRun) {
            try {
                await executeConfiguredAgentAction(agent, responseText, {
                    ...trigger,
                    type: trigger.type || 'manual',
                    label: `${trigger.label || trigger.type} / automatic action`,
                }, completionCtx);
                appendOperationLogDetail(logId, 'Automatic JavaScript action completed successfully.');
            } catch (actionError) {
                appendOperationLogDetail(logId, `Automatic JavaScript action failed: ${actionError?.message ?? String(actionError)}`);
                toastr.error(`${agent.name} output was saved, but its action failed.`, EXTENSION_LABEL);
                if (trigger.type === 'before-character') throw actionError;
            }
        }
        cancellableOperations.assertActive(cancellation);
        completeOperationLog(logId, 'success');
        clearBackstageIssueIfSource(`Agent: ${operationName}`);
        backstageLogger.info(logScope, 'Execution completed', {
            outputCharacters: responseText.length,
            runId,
        });
        return responseText;
    } catch (error) {
        const message = error?.message ?? String(error);
        if (isAbortError(error) || cancellation.controller.signal.aborted) {
            appendOperationLogDetail(logId, 'Execution stopped by operator. Any tool side effect already accepted by its backend was not rolled back.');
            completeOperationLog(logId, 'stopped');
            backstageLogger.info(logScope, 'Execution stopped');
            return null;
        }
        const diagnostic = rawOutput
            ? `${message}\n\nLLM output (original):\n${rawOutput}`
            : message;
        saveAgentRuntimeState(agent.id, {
            lastStatus: 'error',
            lastError: message,
            lastTrigger: trigger.label || trigger.type,
        }, ctx);
        updateOperationLog(logId, { error: diagnostic });
        completeOperationLog(logId, 'error');
        backstageLogger.error(logScope, 'Execution failed', error);
        sceneDirectorState = {
            ...sceneDirectorState,
            persistentIssue: message,
            persistentIssueSource: `Agent: ${operationName}`,
            persistentIssueAt: new Date(),
        };
        refreshSceneDirectorPanel();
        throw error;
    } finally {
        if (cancellableOperations.finish(cancellation)) {
            runningAgentIds.delete(agent.id);
        }
        refreshSceneDirectorPanel();
    }
}

function getAgentOocDraft(agentId) {
    const id = normalizeAgentId(agentId);
    return String(sceneDirectorState.agentOocDrafts?.[id] ?? AGENT_OOC_DEFAULT_DRAFT);
}

function getAgentOocHistory(agentId) {
    const id = normalizeAgentId(agentId);
    const history = sceneDirectorState.agentOocHistories?.[id];
    return Array.isArray(history) ? history : [];
}

function updateAgentOocState(agentId, patch = {}) {
    const id = normalizeAgentId(agentId);
    if (!id) return;

    sceneDirectorState = {
        ...sceneDirectorState,
        agentOocDrafts: Object.hasOwn(patch, 'draft')
            ? { ...(sceneDirectorState.agentOocDrafts ?? {}), [id]: String(patch.draft ?? '') }
            : sceneDirectorState.agentOocDrafts,
        agentOocHistories: Object.hasOwn(patch, 'history')
            ? { ...(sceneDirectorState.agentOocHistories ?? {}), [id]: Array.isArray(patch.history) ? patch.history : [] }
            : sceneDirectorState.agentOocHistories,
    };
}

async function runAgentOocRequest(agentId) {
    const agent = getAgentDefinition(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const connection = resolveAgentConnection(agent, config);
    if (!connection.profileId) {
        toastr.warning(`Configure ${connection.label} for ${agent.name} first.`, EXTENSION_LABEL);
        return null;
    }
    if (runningAgentIds.has(agent.id)) {
        toastr.info(`${agent.name} is already running.`, EXTENSION_LABEL);
        return null;
    }

    const oocRequest = getAgentOocDraft(agent.id).trim();
    if (!oocRequest) {
        toastr.info('Write an OOC request first.', EXTENSION_LABEL);
        return null;
    }

    const ctx = SillyTavern.getContext();
    const originChatKey = getChatContextKey(ctx);
    const operationKind = `agent-ooc:${agent.id}`;
    const operationName = getAgentOperationDisplayName(agent);
    const logScope = getAgentLogScope(agent);
    const logId = beginOperationLog(
        operationKind,
        `Agent OOC: ${operationName}`,
        'Direct agent workspace request',
        getTimingModelLabel(connection.profileId, connection.profileName),
    );
    updateOperationLog(logId, { agentId: agent.id });
    const cancellation = cancellableOperations.start(`agent:${agent.id}`, {
        logId,
        mode: 'ooc',
        agentId: agent.id,
    });
    runningAgentIds.add(agent.id);
    refreshSceneDirectorPanel();
    backstageLogger.info(logScope, 'OOC request started');

    try {
        cancellableOperations.assertActive(cancellation);
        const agentContext = await buildAgentContextSnapshot(
            agent,
            { type: 'ooc', label: 'Manual OOC request from Agents workspace' },
            ctx,
        );
        cancellableOperations.assertActive(cancellation);
        const priorHistory = getAgentOocHistory(agent.id)
            .slice(-12)
            .map(message => ({
                role: message?.role === 'user' ? 'user' : 'assistant',
                content: String(message?.content ?? ''),
            }));
        const budgetedRequest = await fitContextMessagesToInputBudget(
            connection.profileId,
            agentContext,
            currentContext => buildAgentMessages(currentContext, {
                mode: 'ooc',
                priorHistory,
                oocRequest,
            }),
        );
        cancellableOperations.assertActive(cancellation);
        const messages = budgetedRequest.messages;
        updateOperationLog(logId, {
            context: formatAgentContextForLog(budgetedRequest.context),
            request: formatPromptMessages(messages),
            inputTokens: budgetedRequest.inputTokens,
            detail: [
                `Profile: ${connection.profileName || connection.profileId}`,
                `Connection source: ${connection.label}`,
                `History messages: ${priorHistory.length}`,
                `Persisted output: ${agentContext.previousOutput.length} chars (${routerPromptUsesTag('previousOutput', agent.prompt) ? 'prompt tag' : 'dedicated OOC system message'})`,
                `Lorebooks: ${(agent.worldInfoBooks ?? []).join(', ') || 'none'}`,
                `Long-term memory OOC tools: ${agent.graphitiOocEnabled ? 'enabled' : 'disabled'}`,
                `Tool-call round limit: ${agent.maxToolRounds}`,
                `Input budget: ${budgetedRequest.budget}`,
                `Input trimmed: ${budgetedRequest.trimmed}`,
            ].join('\n'),
        });

        const oocToolRuntime = buildAgentGraphitiToolRuntime(agent, 'ooc');
        if (oocToolRuntime) {
            appendOperationLogDetail(logId, `Long-term memory tools: ${oocToolRuntime.summary}`);
        }
        const response = oocToolRuntime
            ? await sendAgentToolRequest(connection.profileId, messages, logId, oocToolRuntime, agent.maxToolRounds, cancellation.controller.signal)
            : await sendAgentStreamingRequest(connection.profileId, messages, cancellation.controller.signal);
        cancellableOperations.assertActive(cancellation);
        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? '';
        const responseText = stripMarkdownFence(extractResponseText(response));
        if (!responseText) throw new Error(`Agent ${agent.name} returned an empty OOC response.`);
        if (getChatContextKey(SillyTavern.getContext()) !== originChatKey) {
            throw new Error(`Chat changed while ${agent.name} OOC was running. Response was discarded.`);
        }

        const nextHistory = [
            ...getAgentOocHistory(agent.id),
            { role: 'user', content: oocRequest },
            { role: 'assistant', content: responseText },
        ];
        updateAgentOocState(agent.id, {
            draft: AGENT_OOC_DEFAULT_DRAFT,
            history: nextHistory,
        });
        updateOperationLog(logId, {
            response: responseText,
            reasoning: String(reasoning ?? ''),
        });
        completeOperationLog(logId, 'success');
        clearBackstageIssueIfSource(`Agent OOC: ${operationName}`);
        backstageLogger.info(logScope, 'OOC request completed', { responseCharacters: responseText.length });
        return responseText;
    } catch (error) {
        const message = error?.message ?? String(error);
        if (isAbortError(error) || cancellation.controller.signal.aborted) {
            appendOperationLogDetail(logId, 'OOC request stopped by operator. Any tool side effect already accepted by its backend was not rolled back.');
            completeOperationLog(logId, 'stopped');
            backstageLogger.info(logScope, 'OOC request stopped');
            return null;
        }
        updateOperationLog(logId, { error: message });
        completeOperationLog(logId, 'error');
        backstageLogger.error(logScope, 'OOC request failed', error);
        sceneDirectorState = {
            ...sceneDirectorState,
            persistentIssue: message,
            persistentIssueSource: `Agent OOC: ${operationName}`,
            persistentIssueAt: new Date(),
        };
        toastr.error(message, EXTENSION_LABEL);
        return null;
    } finally {
        if (cancellableOperations.finish(cancellation)) {
            runningAgentIds.delete(agent.id);
        }
        refreshSceneDirectorPanel();
    }
}

function stopAgentExecution(agentId) {
    const agent = getAgentDefinition(agentId);
    if (!agent) return false;

    const operation = cancellableOperations.stop(`agent:${agent.id}`, `${agent.name} stopped by operator.`);
    if (!operation) return false;

    runningAgentIds.delete(agent.id);
    saveAgentRuntimeState(agent.id, {
        lastStatus: 'stopped',
        lastError: '',
    });
    appendOperationLogDetail(operation.metadata.logId, 'Stop requested by operator. Waiting code and late responses have been detached.');
    completeOperationLog(operation.metadata.logId, 'stopped');
    backstageLogger.info(getAgentLogScope(agent), 'Stop requested', { mode: operation.metadata.mode });
    refreshSceneDirectorPanel();
    return true;
}

async function runDueAgents(agentIds, event) {
    let orderedIds;
    try {
        orderedIds = sortScheduledAgents(agentIds);
    } catch (error) {
        const logId = appendOperationLog({
            kind: 'agent-scheduler',
            step: 'Agent scheduler',
            status: 'error',
            completedAt: new Date(),
            durationMs: 0,
            error: error?.message ?? String(error),
        });
        completeOperationLog(logId, 'error');
        return;
    }

    for (const id of orderedIds) {
        const agent = getAgentDefinition(id);
        const runtime = getAgentRuntimeState(id);
        if (!agent?.enabled || runtime.pendingTurns < agent.interval) continue;
        try {
            await executeAgent(id, {
                type: 'scheduled',
                label: event.label,
                consumedTurns: agent.interval,
            });
        } catch (error) {
            backstageLogger.error(getAgentLogScope(id), 'Scheduled execution failed', error);
        }
    }
}

function scheduleAgentsForTurn(event) {
    if (!config.enabled) return;
    const ctx = SillyTavern.getContext();
    const dueIds = [];
    let changed = false;

    for (const agent of Array.isArray(config.agents) ? config.agents : []) {
        if (!agentScheduleMatchesEvent(agent, event)) continue;
        const runtime = getAgentRuntimeState(agent.id, ctx);
        const pendingTurns = runtime.pendingTurns + 1;
        saveAgentRuntimeState(agent.id, { pendingTurns }, ctx);
        changed = true;
        if (pendingTurns >= agent.interval) dueIds.push(agent.id);
    }

    if (changed) refreshSceneDirectorPanel();
    if (!dueIds.length) return;

    agentSchedulerQueue = agentSchedulerQueue
        .catch(() => {})
        .then(() => runDueAgents(dueIds, event));
}

async function runAgentsBeforeCharacter(char, cancellation = null) {
    const originChatKey = getChatContextKey(SillyTavern.getContext());
    const agents = (config.agents ?? []).filter(agent => {
        if (!agent.enabled || agent.scheduleType !== 'before-character') return false;
        if (agent.ownerType === AGENT_OWNER_TYPES.CHARACTER) {
            return findCharacterConnection(agent, config.characters) === char;
        }
        const target = String(agent.characterName ?? '').trim().toLocaleLowerCase();
        const speaker = String(char.name ?? '').trim().toLocaleLowerCase();
        return !!target && (target === speaker || target === speaker.split(/\s+/)[0]);
    });

    for (const id of sortScheduledAgents(agents.map(agent => agent.id))) {
        if (cancellation) cancellableOperations.assertActive(cancellation);
        const agent = getAgentDefinition(id);
        if (getChatContextKey(SillyTavern.getContext()) !== originChatKey) {
            throw new Error('Chat changed before the character turn. Generation was blocked.');
        }
        if (runningAgentIds.has(id) || runningAgentActionIds.has(id) || cancellableOperations.isActive(`agent:${id}`)) {
            throw new Error(`Required agent ${agent.name} is already running. ${char.name}'s turn was blocked.`);
        }

        updateRouterState({ status: 'waiting-agents' });
        backstageLogger.info(`Character:${char.name}`, 'Waiting for required agent', { agentId: id, agent: agent.name });
        const execution = executeAgent(id, {
            type: 'before-character',
            label: `Before character turn: ${char.name}`,
        });
        const operation = cancellableOperations.get(`agent:${id}`);
        const agentSignal = operation?.controller.signal;
        const parentSignal = cancellation?.controller.signal;
        let rejectWait;
        const interrupted = new Promise((_, reject) => { rejectWait = reject; });
        const onAgentStopped = () => rejectWait(new Error(`Required agent ${agent.name} was stopped. ${char.name}'s turn was blocked.`));
        const onRouterStopped = () => {
            if (operation && cancellableOperations.get(operation.key)?.token === operation.token) {
                stopAgentExecution(id);
            }
            rejectWait(parentSignal.reason);
        };
        agentSignal?.addEventListener('abort', onAgentStopped, { once: true });
        parentSignal?.addEventListener('abort', onRouterStopped, { once: true });
        try {
            if (parentSignal?.aborted) onRouterStopped();
            if (agentSignal?.aborted) onAgentStopped();
            const output = await Promise.race([execution, interrupted]);
            if (cancellation) cancellableOperations.assertActive(cancellation);
            if (!output) throw new Error(`Required agent ${agent.name} did not complete. ${char.name}'s turn was blocked.`);
            if (getChatContextKey(SillyTavern.getContext()) !== originChatKey) {
                throw new Error('Chat changed during required agents. Character generation was blocked.');
            }
        } finally {
            agentSignal?.removeEventListener('abort', onAgentStopped);
            parentSignal?.removeEventListener('abort', onRouterStopped);
        }
    }
}

function normalizePersistedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }

    const savedAt = String(snapshot.savedAt ?? '').trim();
    const path = String(snapshot.path ?? '').trim();
    const fileName = String(snapshot.fileName ?? '').trim();
    const content = String(snapshot.content ?? '');
    if (!savedAt || !path || !fileName || !content.trim()) {
        return null;
    }

    return { savedAt, path, fileName, content };
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(String(value ?? ''));
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
}

async function getStRequestHeaders() {
    const { getRequestHeaders } = await import('/script.js');
    return getRequestHeaders();
}

async function uploadUserFile(name, content, signal = null) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: await getStRequestHeaders(),
        body: JSON.stringify({
            name,
            data: encodeBase64Utf8(content),
        }),
        signal,
    });

    if (!response.ok) {
        throw new Error((await response.text()) || `Upload failed with status ${response.status}`);
    }

    const payload = await response.json();
    const path = String(payload?.path ?? '').trim();
    if (!path) {
        throw new Error('Upload succeeded without a returned file path.');
    }

    return path;
}

async function deleteUserFile(path) {
    const targetPath = String(path ?? '').trim();
    if (!targetPath) {
        return;
    }

    const response = await fetch('/api/files/delete', {
        method: 'POST',
        headers: await getStRequestHeaders(),
        body: JSON.stringify({ path: targetPath }),
    });

    if (!response.ok && response.status !== 404) {
        throw new Error((await response.text()) || `Delete failed with status ${response.status}`);
    }
}

function getAgentOutputSnapshots(agentId, ctx = SillyTavern.getContext()) {
    return getAgentRuntimeState(agentId, ctx).snapshots;
}

function shouldPersistAgentOutputSnapshot(agentId, now = new Date(), ctx = SillyTavern.getContext()) {
    const runtime = getAgentRuntimeState(agentId, ctx);
    const lastSavedAt = runtime.lastSnapshotAt || runtime.snapshots[0]?.savedAt || '';
    if (!lastSavedAt) return true;

    const lastSavedMs = Date.parse(lastSavedAt);
    if (!Number.isFinite(lastSavedMs)) return true;
    return now.getTime() - lastSavedMs >= AGENT_OUTPUT_SNAPSHOT_MIN_INTERVAL_MS;
}

function buildAgentOutputSnapshotFileName(agentId, savedAt = new Date()) {
    const safeAgentId = (normalizeAgentId(agentId) || 'agent').replace(/:/g, '-');
    const stamp = savedAt.toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    return `backstage-agent-${safeAgentId}-${stamp}-${suffix}.md`;
}

async function maybePersistAgentOutputSnapshot(agentId, value, ctx = SillyTavern.getContext(), signal = null) {
    const output = String(value ?? '');
    if (!output.trim()) return null;

    const now = new Date();
    if (!shouldPersistAgentOutputSnapshot(agentId, now, ctx)) return null;

    const fileName = buildAgentOutputSnapshotFileName(agentId, now);
    signal?.throwIfAborted();
    const path = await uploadUserFile(fileName, output, signal);
    signal?.throwIfAborted();
    const snapshot = {
        savedAt: now.toISOString(),
        path,
        fileName,
        content: output,
    };
    const runtime = getAgentRuntimeState(agentId, ctx);
    const existing = runtime.snapshots;
    const nextSnapshots = [snapshot, ...existing].slice(0, AGENT_OUTPUT_SNAPSHOT_RETENTION);
    const prunedSnapshots = existing.slice(Math.max(0, AGENT_OUTPUT_SNAPSHOT_RETENTION - 1));

    signal?.throwIfAborted();
    saveAgentRuntimeState(agentId, {
        snapshots: nextSnapshots,
        lastSnapshotAt: snapshot.savedAt,
    }, ctx);

    await Promise.allSettled(
        prunedSnapshots
            .map(entry => entry?.path)
            .filter(Boolean)
            .map(pathToDelete => deleteUserFile(pathToDelete)),
    );

    return snapshot;
}

async function copyAgentOutputSnapshot(agentId, index, ctx = SillyTavern.getContext()) {
    const snapshot = getAgentOutputSnapshots(agentId, ctx)[index];
    if (!snapshot) {
        toastr.info(`Agent snapshot ${index + 1} unavailable.`, EXTENSION_LABEL);
        return false;
    }

    await navigator.clipboard.writeText(snapshot.content);
    toastr.success(`Agent snapshot ${index + 1} copied.`, EXTENSION_LABEL);
    return true;
}

function stripMarkdownFence(text) {
    return String(text ?? '')
        .trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function tokenizeXmlOutput(text) {
    const tokens = [];
    const pattern = /<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*>/g;
    let match;

    while ((match = pattern.exec(String(text ?? ''))) !== null) {
        const closing = Boolean(match[1]);
        const label = String(match[2] ?? '').trim();
        tokens.push({
            name: label,
            label,
            closing,
            start: match.index,
            end: pattern.lastIndex,
        });
    }

    return tokens;
}

function parseXmlOutput(text, requiredNames = null) {
    const source = String(text ?? '');
    const tokens = tokenizeXmlOutput(source);
    const namesWithClosers = new Set(tokens.filter(token => token.closing).map(token => token.name));
    const structuralNames = requiredNames instanceof Set
        ? new Set(requiredNames)
        : namesWithClosers;
    const stack = [];
    const nodes = [];
    const signature = [];
    const errors = [];

    for (const token of tokens) {
        if (!structuralNames.has(token.name)) continue;
        signature.push(`${token.closing ? '/' : ''}${token.name}`);

        if (!token.closing) {
            const node = { ...token, openEnd: token.end, closeStart: -1, closeEnd: -1 };
            stack.push(node);
            nodes.push(node);
            continue;
        }

        const opened = stack.pop();
        if (!opened) {
            errors.push(`Unexpected closing tag </${token.label}>.`);
            continue;
        }
        if (opened.name !== token.name) {
            errors.push(`Tag <${opened.label}> was closed by </${token.label}>.`);
            continue;
        }
        opened.closeStart = token.start;
        opened.closeEnd = token.end;
    }

    for (const opened of stack.reverse()) {
        errors.push(`Tag <${opened.label}> is not closed.`);
    }

    return { source, tokens, structuralNames, nodes, signature, errors };
}

function getOutputFormatContract(promptTemplate) {
    const prompt = String(promptTemplate ?? '');
    const markers = [...prompt.matchAll(/\bOUTPUT\s+FORMAT\b/gi)];
    const marker = markers[markers.length - 1];
    if (!marker) {
        return {
            valid: false,
            error: 'Output format validation failed: the system prompt has no OUTPUT FORMAT section.',
        };
    }

    const formatSection = prompt.slice(Number(marker.index) + marker[0].length);
    const contract = parseXmlOutput(formatSection);
    if (!contract.structuralNames.size) {
        return {
            valid: false,
            error: 'Output format validation failed: OUTPUT FORMAT contains no <TAG>...</TAG> blocks.',
        };
    }
    if (contract.errors.length) {
        return {
            valid: false,
            error: `Output format validation failed: ${contract.errors.join(' ')}`,
        };
    }

    return { valid: true, error: '', contract };
}

function validateTaggedOutputFormat(promptTemplate, output, optionalTags = []) {
    const format = getOutputFormatContract(promptTemplate);
    if (!format.valid) return format;

    const actual = parseXmlOutput(output, format.contract.structuralNames);
    if (actual.errors.length) {
        return {
            valid: false,
            error: `Output format validation failed: ${actual.errors.join(' ')}`,
        };
    }

    const optionalNames = new Set(optionalTags);
    const presentNames = new Set(actual.tokens.map(token => token.name));
    const omittedBlocks = format.contract.nodes.filter(node => optionalNames.has(node.name) && !presentNames.has(node.name));
    const expectedSignature = format.contract.tokens
        .filter(token => format.contract.structuralNames.has(token.name)
            && !omittedBlocks.some(node => token.start >= node.start && token.end <= node.closeEnd))
        .map(token => `${token.closing ? '/' : ''}${token.name}`);
    const actualSignature = actual.signature;
    const mismatchIndex = expectedSignature.findIndex((tag, index) => actualSignature[index] !== tag);
    if (mismatchIndex >= 0 || expectedSignature.length !== actualSignature.length) {
        const position = mismatchIndex >= 0 ? mismatchIndex : Math.min(expectedSignature.length, actualSignature.length);
        const expected = expectedSignature[position] ? `<${expectedSignature[position]}>` : 'end of output';
        const received = actualSignature[position] ? `<${actualSignature[position]}>` : 'end of output';
        return {
            valid: false,
            error: `Output format mismatch at structural tag ${position + 1}: expected ${expected}, received ${received}.`,
        };
    }

    return {
        valid: true,
        error: '',
        blockCount: actual.nodes.length,
        parsed: actual,
    };
}

function extractTaggedOutputSection(output, tagName, optional = false) {
    const normalizedTag = normalizeOutputTagName(tagName);
    if (!normalizedTag) return { valid: false, content: '', error: 'No output tag was configured.' };
    if (!isValidXmlTagName(normalizedTag)) {
        return { valid: false, content: '', error: `Invalid XML tag name <${normalizedTag}>.` };
    }

    const parsed = parseXmlOutput(output, new Set([normalizedTag]));
    if (parsed.errors.length) {
        return { valid: false, content: '', error: parsed.errors.join(' ') };
    }

    const matches = parsed.nodes.filter(node => node.name === normalizedTag && node.closeStart >= 0);
    if (optional && matches.length === 0) return { valid: true, content: '', block: '', error: '' };
    if (matches.length !== 1) {
        return {
            valid: false,
            content: '',
            error: `Expected exactly one <${normalizeOutputTagName(tagName)}> block, received ${matches.length}.`,
        };
    }

    return {
        valid: true,
        content: parsed.source.slice(matches[0].openEnd, matches[0].closeStart).trim(),
        block: parsed.source.slice(matches[0].start, matches[0].closeEnd).trim(),
        error: '',
    };
}

function getRpContextMessages(chat, includeHidden = false, offset = 0) {
    return selectRpMessages(sliceChatBeforeOffset(chat, offset), { includeHidden, isOoc: isBackstageOocMessage,
        characterNames: [...(SillyTavern.getContext().characters ?? []), ...(config.characters ?? [])].map(character => character.name) });
}

function isToolInvocationChatMessage(message) {
    const type = message?.extra?.type;
    return type === 'tool_call'
        || type === 'tool_response'
        || (Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0);
}

function summarizeToolInvocationsForConsole(invocations) {
    return (Array.isArray(invocations) ? invocations : []).map(invocation => ({
        id: String(invocation?.id ?? ''),
        name: String(invocation?.name ?? invocation?.displayName ?? 'unknown'),
        error: !!invocation?.error,
        parameterCharacters: String(invocation?.parameters ?? '').length,
        resultCharacters: String(invocation?.result ?? '').length,
    }));
}

function formatRpContextMessages(messages, humanName = '') {
    const sanitize = (text) => humanName ? String(text ?? '').replace(/{{user}}/gi, humanName) : String(text ?? '');
    return (Array.isArray(messages) ? messages : [])
        .map(message => `${message?.name || 'Unknown'}: ${sanitize(message?.mes || '')}`);
}

function formatAgentRpContext(agent, messages, ctx, withIndices = false) {
    return formatAgentMessages(messages, ctx.chat, { humanName: ctx.name1 || '', withIndices,
        regexTransform: agent?.applyPromptRegex ? (text, isUser, depth) => getRegexedString(text,
            isUser ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT, { isPrompt: true, depth }) : null });
}

function setRecentChatEntries(target, entries) {
    const normalized = Array.isArray(entries) ? entries.map(entry => String(entry ?? '')) : [];
    target.recentChatEntries = normalized;
    target.recentChat = normalized.join('\n');
    if (target.ownerCharacterName) {
        const prefix = `${target.ownerCharacterName}: `.toLowerCase();
        target.recentCharChatEntries = normalized.filter(entry => entry.replace(/^\[message_index=\d+\]\s*/, '').toLowerCase().startsWith(prefix));
        target.recentCharChat = target.recentCharChatEntries.join('\n');
    }
}

async function buildRouterContextSnapshot(chatHistory, ctx) {
    const sourceChat = Array.isArray(chatHistory) ? chatHistory : (ctx.chat ?? []);
    const realMessages = getRpContextMessages(sourceChat);
    const lastSpeaker = realMessages[realMessages.length - 1]?.name || 'Unknown';
    const playerNames = config.characters.map(c => c.name).join(', ');
    const humanName = ctx.name1 || '';
    const recentChatEntries = routerPromptUsesTag('recentChat')
        ? formatRpContextMessages(realMessages, humanName)
        : [];
    return {
        lastSpeaker,
        playerNames,
        humanName,
        recentChatEntries,
        recentChat: recentChatEntries.join('\n'),
    };
}

async function getRouterContextSnapshot(chatHistory = null, ctx = SillyTavern.getContext()) {
    return withContextSnapshotLock(() => buildRouterContextSnapshot(chatHistory, ctx));
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

    if (isProcessing || cancellableOperations.isActive('router')) {
        toastr.info('Router already running.', EXTENSION_LABEL);
        return null;
    }

    const ctx = SillyTavern.getContext();
    const cancellation = cancellableOperations.start('router', { mode: 'ooc' });
    updateRouterState({
        status: 'router-ooc-running',
        activeTab: 'router',
        routerView: 'workspace',
        lastError: '',
    });

    try {
        beginRuntimePhase('router-ooc', 'Router OOC', 'Direct router workspace request', getTimingModelLabel(config.routerProfileId));
        cancellation.metadata.logId = getActiveOperationLogId('router-ooc');
        const routerContext = await getRouterContextSnapshot(ctx.chat, ctx);
        cancellableOperations.assertActive(cancellation);
        const priorHistory = Array.isArray(sceneDirectorState.routerOocHistory)
            ? sceneDirectorState.routerOocHistory.slice(-12).map(message => ({
                role: message?.role === 'user' ? 'user' : 'assistant',
                content: String(message?.content ?? ''),
            }))
            : [];
        const budgetedRequest = await fitContextMessagesToInputBudget(
            config.routerProfileId,
            routerContext,
            currentContext => buildRouterMessages(currentContext, {
                mode: 'ooc',
                priorHistory,
                oocRequest,
            }),
            { explicitBudget: config.routerInputTokenBudget },
        );
        const messages = budgetedRequest.messages;

        updateRouterState({ lastPromptMessages: messages });
        updateActiveOperationLog('router-ooc', {
            request: formatPromptMessages(messages),
            inputTokens: budgetedRequest.inputTokens,
        });
        const service = await getConnService();
        const response = await service.sendRequest(
            config.routerProfileId,
            messages,
            undefined,
            { stream: false, extractData: true, signal: cancellation.controller.signal },
        );
        cancellableOperations.assertActive(cancellation);
        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? '';
        const responseText = stripMarkdownFence(extractResponseText(response));
        updateActiveOperationLog('router-ooc', {
            response: responseText,
            reasoning,
        });

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
        clearBackstageIssueIfSource('Router OOC');
        return responseText;
    } catch (error) {
        if (isAbortError(error) || cancellation.controller.signal.aborted) {
            backstageLogger.info('Router', 'Workspace request stopped');
            return null;
        }
        backstageLogger.error('Router', 'Workspace request failed', error);
        recordBackstageIssue('Router OOC', error?.message ?? String(error));
        updateRouterState({
            status: 'router-ooc-error',
            lastError: error?.message ?? String(error),
        });
        toastr.error('Erro ao falar com o router. Veja o console.', EXTENSION_LABEL);
        return null;
    } finally {
        if (cancellableOperations.finish(cancellation)) {
            finishRuntimePhase(['router-ooc']);
        }
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
        backstageLogger.error('Router', 'Direct OOC trigger failed', error);
        recordBackstageIssue('Direct OOC', error?.message ?? String(error));
        skipNextCharacterAutoRouter = false;
        clearCharacterNote();
        clearAgentCharacterInjection();
        clearDirectedOocPrompt();
        finishRuntimePhase(['character-turn'], 'error');
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
    await runRouter('USER_MESSAGE_RENDERED');
}

async function processCompletedCharacterMessage(message, triggerEvent) {
    if (!message || typeof message !== 'object' || handledCharacterTurnMessages.has(message)) {
        return;
    }

    const ctx = SillyTavern.getContext();
    if (ctx.chat?.[ctx.chat.length - 1] !== message || isToolInvocationChatMessage(message)) {
        return;
    }

    if (await isHostGenerationActive()) {
        pendingNativeCharacterMessage = message;
        fl('  =', 'CHARACTER_MESSAGE_RENDERED', 'geração nativa ainda ativa — turno mantido pendente');
        return;
    }

    handledCharacterTurnMessages.add(message);
    pendingNativeCharacterMessage = null;
    scheduleAgentsForTurn({
        type: 'character',
        label: `Scheduled after ${String(message?.name ?? 'character')} turn`,
        characterName: String(message?.name ?? ''),
    });
    if (skipNextCharacterAutoRouter) {
        skipNextCharacterAutoRouter = false;
        return;
    }
    runRouter(triggerEvent);
}

async function handleCharacterTurnCandidate(messageId, triggerEvent) {
    const currentContext = SillyTavern.getContext();
    const renderedMessage = currentContext.chat?.[Number(messageId)] ?? currentContext.chat?.[currentContext.chat.length - 1];
    if (!renderedMessage || isToolInvocationChatMessage(renderedMessage)) {
        return;
    }

    if (await isHostGenerationActive()) {
        pendingNativeCharacterMessage = renderedMessage;
        fl('  =', triggerEvent, 'geracao nativa ainda ativa - router adiado');
        return;
    }

    setTimeout(() => {
        processCompletedCharacterMessage(renderedMessage, triggerEvent);
    }, 300);
}

async function callRouterAgent(chatHistory, cancellation = null) {
    if (!config.enabled || !config.routerProfileId) {
        forcedRouterSpeaker = null;
        return null;
    }

    const ctx = SillyTavern.getContext();
    const routerContext = await getRouterContextSnapshot(chatHistory, ctx);
    if (cancellation) cancellableOperations.assertActive(cancellation);
    const contextSummary = {
        recentMessages: routerContext.recentChatEntries?.length ?? 0,
        forcedSpeaker: forcedRouterSpeaker || '',
    };
    updateRouterState({
        status: 'building-context',
        lastContext: contextSummary,
        lastError: '',
    });
    const budgetedRequest = await fitContextMessagesToInputBudget(
        config.routerProfileId,
        routerContext,
        currentContext => buildRouterMessages(currentContext, {
            mode: 'route',
            forcedSpeaker: forcedRouterSpeaker,
        }),
        { explicitBudget: config.routerInputTokenBudget },
    );
    const messages = budgetedRequest.messages;
    contextSummary.recentMessages = budgetedRequest.context?.recentChatEntries?.length ?? 0;
    contextSummary.inputTokenBudget = budgetedRequest.budget;
    contextSummary.inputTokenBudgetSource = budgetedRequest.budgetSource;
    contextSummary.inputTokens = budgetedRequest.inputTokens;
    contextSummary.inputTrimmed = budgetedRequest.trimmed;
    lastRouterRequest = cloneRouterRequestPayload({
        profileId: config.routerProfileId,
        inputTokenBudget: budgetedRequest.budget,
        inputTokens: budgetedRequest.inputTokens,
        options: { stream: false, extractData: true },
        messages,
    });
    if (window.MultiCaller) {
        window.MultiCaller.lastRouterRequest = lastRouterRequest;
    }
    updateRouterState({
        lastPromptMessages: lastRouterRequest.messages,
    });

    try {
        beginRuntimePhase('router-request', 'Router request', forcedRouterSpeaker ? `Forced speaker: ${forcedRouterSpeaker}` : 'Normal routing', getTimingModelLabel(config.routerProfileId));
        if (cancellation) cancellation.metadata.logId = getActiveOperationLogId('router-request');
        updateActiveOperationLog('router-request', {
            request: formatPromptMessages(lastRouterRequest.messages),
            inputTokens: budgetedRequest.inputTokens,
        });
        updateRouterState({ status: 'calling-director' });

        const service  = await getConnService();
        const response = await service.sendRequest(
            lastRouterRequest.profileId,
            lastRouterRequest.messages,
            undefined,
            { ...lastRouterRequest.options, signal: cancellation?.controller.signal ?? null },
        );
        if (cancellation) cancellableOperations.assertActive(cancellation);

        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? null;

        const responseText = extractResponseText(response);
        updateActiveOperationLog('router-request', {
            response: responseText,
            reasoning: reasoning ?? '',
        });
        if (!responseText) {
            backstageLogger.warn('Router', 'Unknown response format', response);
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

        const decision = parseRouterDecision(responseText);
        updateRouterState({
            status: decision.nextSpeaker ? 'decision-ready' : 'no-decision',
            lastReasoning: reasoning ?? '',
            lastRawOutput: responseText,
            lastDecision: decision,
            lastError: '',
        });
        if (decision.nextSpeaker) clearBackstageIssueIfSource('Router');
        return decision.nextSpeaker ? decision : null;

    } catch (error) {
        if (isAbortError(error) || cancellation?.controller.signal.aborted) {
            throw error;
        }
        backstageLogger.error('Router', 'Request failed', error);
        recordBackstageIssue('Router', error?.message ?? String(error));
        updateRouterState({
            status: 'error',
            lastError: error?.message ?? String(error),
        });
        return null;
    } finally {
        if (!cancellation?.controller.signal.aborted) {
            finishRuntimePhase(['router-request']);
            forcedRouterSpeaker = null;
        }
    }
}

let hostScriptModulePromise = null;
let toolCallingModulePromise = null;

async function getHostScriptModule() {
    hostScriptModulePromise ??= import('/script.js').catch(error => {
        hostScriptModulePromise = null;
        throw error;
    });
    return hostScriptModulePromise;
}

async function isHostGenerationActive() {
    try {
        const host = await getHostScriptModule();
        return typeof host.isGenerating === 'function' && !!host.isGenerating();
    } catch (error) {
        backstageLogger.warn('Generation', 'Failed to inspect native generation state', error);
        return false;
    }
}

async function getToolCallingDiagnostics(type) {
    try {
        toolCallingModulePromise ??= import('/scripts/tool-calling.js').catch(error => {
            toolCallingModulePromise = null;
            throw error;
        });
        const { ToolManager } = await toolCallingModulePromise;
        return {
            supported: !!ToolManager?.isToolCallingSupported?.(),
            canPerform: !!ToolManager?.canPerformToolCalls?.(type),
        };
    } catch (error) {
        return {
            supported: null,
            canPerform: null,
            error: error?.message ?? String(error),
        };
    }
}

async function backstageGenerationInterceptor(chat, contextSize, abort, type) {
    const guard = activeCharacterGenerationGuard;
    if (!guard) {
        return;
    }

    guard.interceptorCalls += 1;
    const coreChatLength = Array.isArray(chat) ? chat.length : 0;
    const coreToolCount = Array.isArray(chat) ? chat.filter(isToolInvocationChatMessage).length : 0;
    const toolDiagnostics = await getToolCallingDiagnostics(type);
    const hostChat = summarizeHostChatForLog();
    let hasChatHistory = null;
    let promptManagerError = '';

    try {
        const { promptManager } = await import('/scripts/openai.js');
        const promptCollection = promptManager?.getPromptCollection?.(type);
        hasChatHistory = !!promptCollection?.has?.('chatHistory');
    } catch (error) {
        promptManagerError = error?.message ?? String(error);
    }

    const details = [
        `Generation interceptor ${guard.interceptorCalls}`,
        `Attempt: ${Math.max(1, Number(guard.attempt) || 1)}/2`,
        `Character: ${guard.charName}`,
        `Type: ${String(type ?? 'normal')}`,
        `Core chat messages: ${coreChatLength}`,
        `Core chat tool blocks: ${coreToolCount}`,
        `Tool calling supported: ${toolDiagnostics.supported == null ? 'inspection failed' : String(toolDiagnostics.supported)}`,
        `Can perform tools for ${String(type ?? 'normal')}: ${toolDiagnostics.canPerform == null ? 'inspection failed' : String(toolDiagnostics.canPerform)}`,
        `Prompt Manager chatHistory: ${hasChatHistory === null ? 'inspection failed' : (hasChatHistory ? 'present' : 'missing')}`,
        `Context size: ${Math.max(0, Number(contextSize) || 0)}`,
        toolDiagnostics.error ? `Tool calling inspection error: ${toolDiagnostics.error}` : '',
        promptManagerError ? `Prompt Manager inspection error: ${promptManagerError}` : '',
    ].filter(Boolean).join('\n');

    appendOperationLogDetail(guard.operationLogId, details);
    backstageLogger.debug('ToolCall', 'Generation interceptor after native coreChat filter', {
        interceptorCall: guard.interceptorCalls,
        attempt: Math.max(1, Number(guard.attempt) || 1),
        character: guard.charName,
        type: String(type ?? 'normal'),
        coreChatMessages: coreChatLength,
        coreChatToolBlocks: coreToolCount,
        toolCallingSupported: toolDiagnostics.supported,
        canPerformTools: toolDiagnostics.canPerform,
        hostMessages: hostChat.total,
        hostToolBlocks: hostChat.toolCount,
        latestHostToolIndex: hostChat.latestToolIndex,
        latestHostToolDistanceFromEnd: hostChat.latestToolDistanceFromEnd,
        latestHostToolType: hostChat.latestToolType,
        latestHostToolNames: hostChat.latestToolNames,
    });

    const abortReason = coreChatLength === 0
        ? 'ST captured an empty coreChat before prompt assembly.'
        : (hasChatHistory === false ? 'Prompt Manager collection is missing chatHistory before prompt assembly.' : '');

    if (!abortReason) {
        return;
    }

    guard.aborted = true;
    guard.abortReason = abortReason;
    appendOperationLogDetail(guard.operationLogId, `GENERATION ABORTED BEFORE API REQUEST: ${abortReason}`);
    abort(true);
}

globalThis.backstageGenerationInterceptor = backstageGenerationInterceptor;

// ================= TRIGGER =================


async function triggerChar(char, decision = null, options = {}) {
    fl('→ START', 'triggerChar', `char=${char.name} | last=${lastActiveChar} | profile=${char.profileName}`);
    backstageLogger.info(`Character:${char.name}`, 'Turn started', {
        profile: char.profileName || char.profileId || 'not configured',
        directOoc: !!options.directOocText,
    });
    let ctx = SillyTavern.getContext();
    const cancellation = options.cancellation ?? null;
    if (cancellation) cancellableOperations.assertActive(cancellation);
    if (!options.directOocText) {
        await runAgentsBeforeCharacter(char, cancellation);
        if (cancellation) cancellableOperations.assertActive(cancellation);
        ctx = SillyTavern.getContext();
    }
    const targetProfile = resolveCharacterProfileForSwitch(char, ctx);

    if (char.name !== lastActiveChar && targetProfile.profileName) {
        if (targetProfile.source === 'profileId' && targetProfile.profileName !== char.profileName) {
            char.profileName = targetProfile.profileName;
            saveConfig();
        }

        const recoveryAnchor = buildChatRecoveryAnchor(ctx);
        const settleMonitor = beginTriggerSettleMonitor(char.name, targetProfile.profileName);
        try {
            fl('  →', 'triggerChar', `/profile await=true "${targetProfile.profileName}" | source=${targetProfile.source}${targetProfile.profileId ? ` | id=${targetProfile.profileId}` : ''}`);
            await ctx.executeSlashCommandsWithOptions(`/profile await=true "${targetProfile.profileName}"`);
            if (cancellation) cancellableOperations.assertActive(cancellation);
            settleMonitor.armRecovery(recoveryAnchor);
            const settleResult = await settleMonitor.promise;
            ctx = SillyTavern.getContext();

            fl('  ←', 'triggerChar', `profile settled | status=${settleResult.status} | events=${settleResult.events.length} | chatLength=${Array.isArray(ctx.chat) ? ctx.chat.length : 0}`);
            backstageLogger.debug(`Character:${char.name}`, 'Connection profile settled', {
                profile: targetProfile.profileName,
                status: settleResult.status,
                events: settleResult.events.map(event => event.name),
                chatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
            });
            if (settleResult.status !== 'settled') {
                const error = new Error(`Profile switch did not recover a stable chat for ${char.name}.`);
                backstageLogger.error(`Character:${char.name}`, 'Generation cancelled after profile switch', {
                    char: char.name,
                    profileName: targetProfile.profileName,
                    status: settleResult.status,
                    note: settleResult.note,
                    quietMs: settleResult.quietMs,
                    maxWaitMs: settleResult.maxWaitMs,
                    events: settleResult.events,
                });
                recordBackstageIssue(`Character turn: ${char.name}`, `${error.message} ${settleResult.note}`);
                throw error;
            }
            lastActiveChar = char.name;
        } catch (error) {
            clearActiveTriggerSettleMonitor();
            lastActiveChar = null;
            throw error;
        }
    } else {
        lastActiveChar = char.name;
        updateRouterState({
            triggerSettle: {
                status: 'skipped',
                note: 'Profile already active. No settle wait was needed.',
                charName: char.name,
                profileName: targetProfile.profileName || char.profileName || '',
                quietMs: PROFILE_SWITCH_SETTLE_QUIET_MS,
                maxWaitMs: PROFILE_SWITCH_SETTLE_MAX_WAIT_MS,
                startedAt: new Date(),
                deadlineAt: new Date(),
                lastEventAt: null,
                lastEventName: '',
                events: [],
            },
        });
    }

    if (!options.directOocText) {
        const reinforcement = await memoryReinforcement.beforeCharacter(char, {
            signal: cancellation?.controller.signal,
        });
        if (cancellation) cancellableOperations.assertActive(cancellation);
        if (reinforcement?.status === 'stopped') {
            throw new DOMException(reinforcement.error || 'Memory reinforcement stopped.', 'AbortError');
        }
        ctx = SillyTavern.getContext();
    }
    setCharacterNote(char.name);
    setDirectedOocPrompt(char.name, options.directOocText);
    const agentInjection = applyAgentCharacterInjection(char.name);
    beginRuntimePhase(
        'character-turn',
        `Character turn: ${char.name}`,
        targetProfile.profileName ? `Profile ${targetProfile.profileName}` : '',
        getTimingModelLabel(char.profileId, targetProfile.profileName || char.profileName || ''),
    );
    const characterOperationLogId = getActiveOperationLogId('character-turn');
    appendOperationLogDetail(characterOperationLogId, formatTriggerSettleForLog(sceneDirectorState.triggerSettle));
    appendOperationLogDetail(
        characterOperationLogId,
        formatHostChatSummaryForLog('Pre-trigger snapshot', summarizeHostChatForLog(ctx)),
    );
    appendOperationLogDetail(characterOperationLogId, [
        `Agent guidance sources: ${agentInjection.applied.map(item => `${item.agent.name} (${item.deliveries.map(delivery => delivery.target.mode).join('+')}; ${formatAgentInjectionPlacement(item.agent)})`).join(', ') || 'none'}`,
        agentInjection.errors.length ? `Agent guidance errors: ${agentInjection.errors.join(' | ')}` : '',
    ].filter(Boolean).join('\n'));
    updateRouterState({ status: 'executing' });

    fl('  →', 'triggerChar', `/trigger await=true "${char.name}"`);
    const generationGuard = {
        charName: char.name,
        operationLogId: characterOperationLogId,
        interceptorCalls: 0,
        attempt: 0,
        aborted: false,
        abortReason: '',
    };
    activeCharacterGenerationGuard = generationGuard;
    const retryRecoveryAnchor = buildChatRecoveryAnchor(ctx);

    try {
        for (let attempt = 1; attempt <= 2; attempt++) {
            generationGuard.attempt = attempt;
            generationGuard.aborted = false;
            generationGuard.abortReason = '';
            const callsBeforeAttempt = generationGuard.interceptorCalls;

            await ctx.executeSlashCommandsWithOptions(`/trigger await=true "${char.name}"`);
            if (cancellation) cancellableOperations.assertActive(cancellation);

            if (!generationGuard.aborted) {
                if (generationGuard.interceptorCalls === callsBeforeAttempt) {
                    throw new Error('Character generation finished without reaching the Backstage generation interceptor.');
                }
                break;
            }

            const canRetry = attempt === 1
                && generationGuard.abortReason === 'ST captured an empty coreChat before prompt assembly.';
            if (!canRetry) {
                throw new Error(generationGuard.abortReason);
            }

            appendOperationLogDetail(
                characterOperationLogId,
                `RETRY 1/1: Waiting for the pre-trigger chat tail to remain stable for ${PROFILE_SWITCH_SETTLE_QUIET_MS}ms before repeating /trigger.`,
            );
            const recovered = await waitForStableChatRecovery(retryRecoveryAnchor);
            if (!recovered) {
                throw new Error(`Chat did not remain stable within ${PROFILE_SWITCH_SETTLE_MAX_WAIT_MS}ms after the empty coreChat abort.`);
            }

            ctx = SillyTavern.getContext();
            appendOperationLogDetail(
                characterOperationLogId,
                formatHostChatSummaryForLog('Retry pre-trigger snapshot', summarizeHostChatForLog(ctx)),
            );
            fl('  â†’', 'triggerChar', `/trigger retry 1/1 await=true "${char.name}"`);
        }
    } catch (error) {
        const message = error?.message ?? String(error);
        const stopped = isAbortError(error) || cancellation?.controller.signal.aborted;
        if (stopped) {
            appendOperationLogDetail(characterOperationLogId, 'Character generation stopped by operator.');
            completeOperationLog(characterOperationLogId, 'stopped');
            throw error;
        }

        updateOperationLog(characterOperationLogId, { error: message });
        appendOperationLogDetail(characterOperationLogId, `Character generation failed: ${message}`);
        recordBackstageIssue(`Character turn: ${char.name}`, message);
        clearCharacterNote();
        clearAgentCharacterInjection();
        clearDirectedOocPrompt();
        finishRuntimePhase(['character-turn'], 'error');
        skipNextCharacterAutoRouter = false;
        pendingAutoRouter = false;
        isProcessing = false;
        unlockChat();
        updateRouterState({
            status: 'error',
            lastError: message,
        });
        throw error;
    } finally {
        if (activeCharacterGenerationGuard === generationGuard) {
            activeCharacterGenerationGuard = null;
        }
    }
    fl('← END', 'triggerChar', `char=${char.name}`);
}

// ================= EXECUÇÃO =================

async function executeDecision(decision, caller = 'unknown', cancellation = null) {
    const nextSpeaker = typeof decision === 'string' ? decision : decision?.nextSpeaker;
    fl('→ START', 'executeDecision', `caller=${caller} | nextSpeaker="${nextSpeaker}"`);
    updateRouterState({
        status: 'executing',
        lastDecision: typeof decision === 'string'
            ? { nextSpeaker: decision, reason: '', direction: '', scenePressure: '', avoid: '', raw: decision, parsed: null }
            : decision,
    });

    const ctx = SillyTavern.getContext();
    if (cancellation) cancellableOperations.assertActive(cancellation);
    const clean = String(nextSpeaker ?? '').trim().toLowerCase();

    if (!clean || clean === 'user' || clean === 'player' || clean === String(ctx.name1 ?? '').trim().toLowerCase()) {
        clearAgentCharacterInjection();
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
        clearAgentCharacterInjection();
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
    await triggerChar(char, decision, { cancellation });

    fl('← END', 'executeDecision', `char=${char.name}`);
    // isProcessing fica true — só libera via GENERATION_ENDED
}

function recoverStaleCharacterGeneration(reason) {
    const operationLogId = getActiveOperationLogId('character-turn');
    if (!operationLogId) {
        return false;
    }

    const message = String(reason ?? 'Character generation state was reset.');
    updateOperationLog(operationLogId, { error: message });
    appendOperationLogDetail(operationLogId, `RECOVERED WITHOUT PAGE RELOAD: ${message}`);
    finishRuntimePhase(['character-turn'], 'error');
    clearCharacterNote();
    clearAgentCharacterInjection();
    clearDirectedOocPrompt();
    clearActiveTriggerSettleMonitor();
    activeCharacterGenerationGuard = null;
    skipNextCharacterAutoRouter = false;
    pendingAutoRouter = false;
    pendingNativeCharacterMessage = null;
    isProcessing = false;
    unlockChat();
    backstageLogger.warn('Generation', 'Recovered stale character generation state', { reason: message });
    return true;
}

async function runRouter(triggerEvent = 'unknown') {
    const isManualTrigger = triggerEvent === 'floating-panel' || String(triggerEvent).startsWith('manual');
    if (cancellableOperations.isActive('router') && !isProcessing) {
        forcedRouterSpeaker = null;
        if (!isManualTrigger) pendingAutoRouter = true;
        fl('  =', 'runRouter', `adiado | router anterior finalizando | trigger=${triggerEvent}`);
        updateRouterState({ status: isManualTrigger ? 'blocked-processing' : 'queued' });
        return;
    }
    if (isProcessing) {
        const hasStaleCharacterOperation = !!getActiveOperationLogId('character-turn');
        if (isManualTrigger && hasStaleCharacterOperation && !await isHostGenerationActive()) {
            recoverStaleCharacterGeneration(`Manual router call detected an inactive ST generation (${triggerEvent}).`);
        }
    }

    if (isProcessing) {
        forcedRouterSpeaker = null;
        if (!isManualTrigger) pendingAutoRouter = true;
        fl('  =', 'runRouter', `bloqueado | isProcessing=true | trigger=${triggerEvent}`);
        updateRouterState({ status: 'blocked-processing' });
        return;
    }
    pendingAutoRouter = false;
    isProcessing = true;
    const cancellation = cancellableOperations.start('router', { mode: 'route', triggerEvent });
    fl('→ START', 'runRouter', `trigger=${triggerEvent}`);
    backstageLogger.info('Router', 'Routing started', { trigger: triggerEvent });
    updateRouterState({ status: 'running', lastError: '' });

    try {
        const ctx      = SillyTavern.getContext();
        const decision = await callRouterAgent(ctx.chat, cancellation);
        cancellableOperations.assertActive(cancellation);
        if (decision) {
            backstageLogger.info('Router', 'Decision ready', {
                nextSpeaker: decision.nextSpeaker,
                reason: decision.reason,
            });
            await executeDecision(decision, 'runRouter', cancellation);
        } else {
            fl('← END', 'runRouter', 'sem decisão');
            isProcessing = false;
            updateRouterState({ status: 'no-decision' });
            backstageLogger.warn('Router', 'No routing decision returned');
        }
    } catch (e) {
        if (cancellableOperations.get('router')?.token !== cancellation.token) return;
        pendingAutoRouter = false;
        skipNextCharacterAutoRouter = false;
        clearCharacterNote();
        clearAgentCharacterInjection();
        clearDirectedOocPrompt();
        isProcessing = false;
        unlockChat();
        if (isAbortError(e) || cancellation.controller.signal.aborted) {
            fl('← END', 'runRouter', 'stopped');
            updateRouterState({ status: 'stopped', lastError: '' });
            return;
        }
        backstageLogger.error('Router', 'Routing failed', e);
        fl('← END', 'runRouter', `erro: ${e.message}`);
        isProcessing = false;
        recordBackstageIssue('Router', e?.message ?? String(e));
        updateRouterState({
            status: 'error',
            lastError: e?.message ?? String(e),
        });
    } finally {
        cancellableOperations.finish(cancellation);
        if (pendingAutoRouter && !isProcessing) {
            pendingAutoRouter = false;
            setTimeout(() => {
                runRouter('queued-after-router-finish');
            }, 0);
        }
    }
}

async function stopRouterExecution() {
    const operation = cancellableOperations.stop('router', 'Router stopped by operator.');
    const hadCharacterOperation = !!getActiveOperationLogId('character-turn');
    const hadWork = !!operation || isProcessing || hadCharacterOperation;
    if (!hadWork) return false;

    if (operation?.metadata?.logId) {
        appendOperationLogDetail(operation.metadata.logId, 'Stop requested by operator. Late router responses will be ignored.');
    }
    clearCharacterNote();
    clearAgentCharacterInjection();
    clearDirectedOocPrompt();
    clearActiveTriggerSettleMonitor();
    activeCharacterGenerationGuard = null;
    skipNextCharacterAutoRouter = false;
    pendingAutoRouter = false;
    pendingNativeCharacterMessage = null;
    isProcessing = false;
    finishRuntimePhase(['router-request', 'router-ooc', 'character-turn'], 'stopped');
    unlockChat();
    updateRouterState({ status: 'stopped', lastError: '' });

    if (await isHostGenerationActive()) {
        try {
            const host = await getHostScriptModule();
            host.stopGeneration?.();
        } catch (error) {
            backstageLogger.warn('Router', 'Native generation stop failed after local state was released', error);
        }
    }

    backstageLogger.info('Router', 'Stop requested; routing state released', {
        requestAborted: !!operation,
        characterGenerationActive: hadCharacterOperation,
    });
    return true;
}

async function runRouterTestRequest() {
    if (isProcessing || cancellableOperations.isActive('router')) {
        toastr.info('Router already running.', EXTENSION_LABEL);
        return null;
    }

    isProcessing = true;
    const cancellation = cancellableOperations.start('router', { mode: 'test' });
    try {
        const ctx = SillyTavern.getContext();
        return await callRouterAgent(ctx.chat, cancellation);
    } catch (error) {
        if (isAbortError(error) || cancellation.controller.signal.aborted) return null;
        throw error;
    } finally {
        if (cancellableOperations.finish(cancellation)) {
            isProcessing = false;
        }
        refreshSceneDirectorPanel();
    }
}

// ================= UI =================

function formatPanelTime(value) {
    if (!value) return 'never';
    return value.toLocaleTimeString();
}

function formatDurationMs(value) {
    const ms = Math.max(0, Number(value) || 0);
    if (!ms) return '0.0s';

    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toFixed(1)}s`;
}

function getRuntimeTimingView(now = new Date()) {
    const timing = cloneRuntimeTiming();
    const activeElapsedMs = timing.activeStartedAt ? Math.max(0, now.getTime() - timing.activeStartedAt.getTime()) : null;

    return {
        activeElapsedText: activeElapsedMs != null ? formatDurationMs(activeElapsedMs) : 'Idle',
    };
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
    if (
        normalized.includes('blocked')
        || normalized.includes('warning')
        || normalized.includes('stopped')
        || normalized.includes('interrupted')
    ) return 'warning';
    if (
        normalized.includes('running')
        || normalized.includes('calling')
        || normalized.includes('building')
        || normalized.includes('settling')
        || normalized.includes('executing')
        || normalized.includes('updating')
    ) {
        return 'info';
    }
    if (normalized.includes('timeout')) return 'warning';
    if (
        normalized.includes('ready')
        || normalized.includes('settled')
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

function getTogglePipelineStatus() {
    const runtimeView = getRuntimeTimingView();
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

        const base = playerNames.includes(lowered) ? 'Your turn' : nextSpeaker;
        return runtimeView.activeElapsedText !== 'Idle'
            ? `${base} ${runtimeView.activeElapsedText}`
            : base;
    }

    if (routerStatus === 'calling-director') return runtimeView.activeElapsedText !== 'Idle' ? `Router ${runtimeView.activeElapsedText}` : 'Router';
    if (routerStatus === 'waiting-agents') return 'Waiting for agents';
    if (routerStatus === 'building-context' || routerStatus === 'running') return runtimeView.activeElapsedText !== 'Idle' ? `Routing ${runtimeView.activeElapsedText}` : 'Routing';
    if (routerStatus === 'blocked-processing') return runtimeView.activeElapsedText !== 'Idle' ? `${lastActiveChar || 'Busy'} ${runtimeView.activeElapsedText}` : (lastActiveChar || 'Busy');

    if (isProcessing && lastActiveChar) {
        return runtimeView.activeElapsedText !== 'Idle'
            ? `${lastActiveChar} ${runtimeView.activeElapsedText}`
            : lastActiveChar;
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

function renderEditorMeta(note, counterId) {
    return `
        <div class="sd-editor-meta">
            <div class="sd-footnote">${escapeHtml(note)}</div>
            <div id="${escapeHtml(counterId)}" class="sd-token-counter">-</div>
        </div>
    `;
}

function renderTokenCountedConsole(value, fallback = '', extraClass = '') {
    const content = String(value ?? '');
    const hasContent = !!content.trim();
    const displayValue = hasContent ? content : String(fallback ?? '');
    const classes = ['sd-console', extraClass].filter(Boolean).join(' ');

    return `
        <div data-token-count-container>
            <pre class="${escapeHtml(classes)}" data-token-count-source data-token-count-empty="${hasContent ? 'false' : 'true'}">${escapeHtml(displayValue)}</pre>
            <div class="sd-editor-meta">
                <div></div>
                <div class="sd-token-counter" data-token-count-result>${hasContent ? '-' : '0 tokens'}</div>
            </div>
        </div>
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
    `;
}

function renderContextSummary(context) {
    if (!context) {
        return '<div class="sd-muted">No context built yet.</div>';
    }

    return `
        <div class="sd-kv"><span>recentMessages</span><b>${escapeHtml(context.recentMessages)}</b></div>
        <div class="sd-kv"><span>input budget</span><b>${escapeHtml(context.inputTokenBudget ?? 0)}</b></div>
        <div class="sd-kv"><span>input tokens</span><b>${escapeHtml(context.inputTokens ?? 0)}</b></div>
        <div class="sd-kv"><span>budget trim</span><b>${context.inputTrimmed ? 'true' : 'false'}</b></div>
    `;
}

function renderTriggerSettleSummary(state) {
    if (!state) {
        return '<div class="sd-muted">No trigger settle recorded yet.</div>';
    }

    const events = Array.isArray(state.events) ? state.events : [];
    const eventLines = events.length
        ? events.map((event) => {
            const when = event?.at ? formatPanelTime(new Date(event.at)) : '--:--';
            const detail = String(event?.detail ?? '').trim();
            return `${when} | ${String(event?.name ?? '').trim()}${detail ? ` | ${detail}` : ''}`;
        }).join('\n')
        : 'No settle-reset events captured.';

    return `
        <div class="sd-kv"><span>Status</span><b>${escapeHtml(formatStateLabel(state.status || 'idle'))}</b></div>
        <div class="sd-kv"><span>Character</span><b>${escapeHtml(state.charName || '')}</b></div>
        <div class="sd-kv"><span>Profile</span><b>${escapeHtml(state.profileName || '')}</b></div>
        <div class="sd-kv"><span>Anchor</span><b>${state.anchorSeen ? escapeHtml(state.anchorEventName || 'seen') : 'waiting for CHAT_CHANGED'}</b></div>
        <div class="sd-kv"><span>Quiet window</span><b>${escapeHtml(`${Number(state.quietMs) || 0} ms`)}</b></div>
        <div class="sd-kv"><span>Max wait</span><b>${escapeHtml(`${Number(state.maxWaitMs) || 0} ms`)}</b></div>
        <div class="sd-kv"><span>Started</span><b>${escapeHtml(formatPanelTime(state.startedAt))}</b></div>
        <div class="sd-kv"><span>Last event</span><b>${escapeHtml(state.lastEventName || 'none')}</b></div>
        <div class="sd-footnote">${escapeHtml(state.note || '')}</div>
        ${renderTokenCountedConsole(eventLines)}
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

function getAgentOwners() {
    return [
        { key: AGENT_OWNER_TYPES.GLOBAL, label: 'Global', type: AGENT_OWNER_TYPES.GLOBAL, character: null },
        ...config.characters.map((character, index) => ({
            key: `character:${character.avatar || character.name}`,
            label: character.name,
            type: AGENT_OWNER_TYPES.CHARACTER,
            character,
            characterIndex: index,
        })),
    ];
}

function getActiveAgentOwner() {
    const owners = getAgentOwners();
    const selectedAgent = (config.agents ?? []).find(agent => agent.id === sceneDirectorState.activeAgentId);
    const requestedKey = sceneDirectorState.activeAgentOwnerKey || (selectedAgent ? getAgentOwnerKey(selectedAgent) : '');
    const owner = owners.find(item => item.key === requestedKey) ?? owners[0];
    sceneDirectorState.activeAgentOwnerKey = owner.key;
    return owner;
}

function getAgentsForOwner(ownerKey = getActiveAgentOwner().key) {
    return (Array.isArray(config.agents) ? config.agents : [])
        .filter(agent => agent.internalType !== SUMMARY_CREATION_TYPE && getAgentOwnerKey(agent) === ownerKey)
        .sort((left, right) => (left.displayOrder || 0) - (right.displayOrder || 0));
}

function reorderVisibleAgent(sourceId, targetId, after = false) {
    const agents = getAgentsForOwner();
    const source = agents.find(agent => agent.id === sourceId);
    if (!source || sourceId === targetId || !agents.some(agent => agent.id === targetId)) return;
    const reordered = agents.filter(agent => agent !== source);
    reordered.splice(reordered.findIndex(agent => agent.id === targetId) + (after ? 1 : 0), 0, source);
    reordered.forEach((agent, index) => { agent.displayOrder = index; });
    saveConfig();
}

function getSelectedAgent() {
    const owner = getActiveAgentOwner();
    if (sceneDirectorState.characterView === 'summary' && owner.character
        && getSectionSelection(`summary:${owner.key}`, 'Memories') === 'Creation') {
        if (sceneDirectorState.agentView === 'script') sceneDirectorState.agentView = 'config';
        return getSummaryCreationAgent(owner.character);
    }
    if (sceneDirectorState.characterView === 'summary') return null;
    const agents = getAgentsForOwner();
    const selected = agents.find(agent => agent.id === sceneDirectorState.activeAgentId) ?? agents[0] ?? null;
    if (selected && sceneDirectorState.activeAgentId !== selected.id) {
        sceneDirectorState.activeAgentId = selected.id;
    }
    if (!selected && sceneDirectorState.activeAgentId) {
        sceneDirectorState.activeAgentId = '';
    }
    return selected;
}

function formatAgentSchedule(agent) {
    if (!agent || agent.scheduleType === 'manual') return 'Manual only';
    if (agent.scheduleType === 'user-turns') return `Every ${agent.interval} user turns`;
    if (agent.scheduleType === 'total-turns') return `Every ${agent.interval} total turns`;
    const characterName = agent.ownerType === AGENT_OWNER_TYPES.CHARACTER
        ? getAgentOwnerLabel(agent)
        : agent.characterName;
    if (agent.scheduleType === 'before-character') return `Before each turn by ${characterName || 'unassigned character'}`;
    return `Every ${agent.interval} turns by ${characterName || 'unassigned character'}`;
}

function getAgentOwnerLabel(agent) {
    if (agent?.ownerType !== AGENT_OWNER_TYPES.CHARACTER) return 'Global';
    return findCharacterConnection(agent, config.characters)?.name || agent.ownerCharacterName || 'Unavailable character';
}

function getAgentOperationDisplayName(agent) {
    const agentName = String(agent?.name ?? 'Unknown agent').trim() || 'Unknown agent';
    if (agent?.ownerType !== AGENT_OWNER_TYPES.CHARACTER) return agentName;
    return `${getAgentOwnerLabel(agent)} / ${agentName}`;
}

function applyAgentOwnerValue(agent, value) {
    const raw = String(value ?? 'global');
    if (!raw.startsWith('character:')) {
        agent.ownerType = AGENT_OWNER_TYPES.GLOBAL;
        agent.ownerCharacterAvatar = '';
        agent.ownerCharacterName = '';
        return;
    }

    const identity = raw.slice('character:'.length);
    const character = config.characters.find(item => String(item.avatar || item.name) === identity);
    agent.ownerType = AGENT_OWNER_TYPES.CHARACTER;
    agent.ownerCharacterAvatar = String(character?.avatar ?? '');
    agent.ownerCharacterName = String(character?.name ?? identity);
}

function renderCharacterConnections(activeOwner) {
    const connectionContent = activeOwner.type === AGENT_OWNER_TYPES.GLOBAL
        ? `
            <div class="sd-connection-field">
            <label>Agent Connection</label>
            <select id="global-agent-profile" class="text_pole"></select>
            </div>
        `
        : `
            <div class="sd-connection-field">
            <label>Generation Connection</label>
            <select id="char-generation-profile-${activeOwner.characterIndex}" class="text_pole"></select>
            </div>
            <div class="sd-connection-field">
            <label>Agent Connection</label>
            <select class="text_pole" data-character-agent-mode="${activeOwner.characterIndex}">
                <option value="generation" ${activeOwner.character.agentProfileMode === CHARACTER_AGENT_CONNECTION_MODES.GENERATION ? 'selected' : ''}>Inherit Generation Connection</option>
                <option value="profile" ${activeOwner.character.agentProfileMode === CHARACTER_AGENT_CONNECTION_MODES.PROFILE ? 'selected' : ''}>Use another profile</option>
            </select>
            <select id="char-agent-profile-${activeOwner.characterIndex}" class="text_pole ${activeOwner.character.agentProfileMode === CHARACTER_AGENT_CONNECTION_MODES.PROFILE ? '' : 'sd-hidden'}"></select>
            </div>
        `;

    return `<div id="character-connections" class="sd-character-connections${sceneDirectorState.characterConnectionsOpen ? '' : ' sd-hidden'}">${connectionContent}</div>`;
}

function renderCharacterPortrait(owner) {
    const initial = String(owner.label || '?').slice(0, 1).toUpperCase();
    const avatar = String(owner.character?.avatar ?? '');
    const image = avatar && avatar !== 'none'
        ? `<img data-character-portrait src="${escapeHtml(`/thumbnail?${new URLSearchParams({ type: 'avatar', file: avatar })}`)}" alt="" width="64" height="64" loading="lazy" decoding="async">`
        : '';
    return `<span class="sd-character-portrait" aria-hidden="true">${owner.type === AGENT_OWNER_TYPES.GLOBAL ? '<i class="fa-solid fa-globe"></i>' : `<span>${escapeHtml(initial)}</span>`}${image}</span>`;
}

function renderCharacterPicker(activeOwner) {
    const agents = Array.isArray(config.agents) ? config.agents : [];
    const owners = getAgentOwners();
    return `
        <details class="sd-character-picker">
            <summary title="Select character" aria-label="${escapeHtml(`Choose character: ${activeOwner.label}`)}" aria-expanded="false">
                ${renderCharacterPortrait(activeOwner)}
                <span class="sd-character-selector-name">${escapeHtml(activeOwner.label)}</span>
                <i class="fa-solid fa-chevron-down sd-character-picker-chevron" aria-hidden="true"></i>
            </summary>
            <div class="sd-character-picker-menu" role="group" aria-label="Characters">
                <div class="sd-character-picker-heading"><b>Characters</b>
                <button id="agent-refresh-group" class="sd-editor-tool" title="Refresh active group" aria-label="Refresh active group"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button>
                </div>
            <div class="sd-character-picker-grid">
                ${owners.map(owner => {
                    const count = agents.filter(agent => getAgentOwnerKey(agent) === owner.key).length;
                    return `
                        <button type="button" class="sd-character-choice" data-agent-owner-key="${escapeHtml(owner.key)}" aria-pressed="${owner.key === activeOwner.key}" title="${escapeHtml(owner.label)}">
                            ${renderCharacterPortrait(owner)}
                            <span class="sd-character-choice-name">${escapeHtml(owner.label)}</span>
                            <small>${count} ${count === 1 ? 'agent' : 'agents'}</small>
                        </button>
                    `;
                }).join('')}
            </div>
            </div>
        </details>
    `;
}

function renderAgentList(selectedAgent, activeOwner) {
    const agents = getAgentsForOwner(activeOwner.key);
    return `
        <aside class="sd-agent-list-pane">
            <div class="sd-agent-list-head">
                <div>
                    <div class="sd-card-title">${escapeHtml(activeOwner.label)} agents</div>
                    <div class="sd-card-subtitle">Only this owner's agents are shown.</div>
                </div>
                <span class="sd-agent-count">${agents.length}</span>
            </div>
            <div class="sd-agent-create">
                <input id="agent-new-name" class="text_pole" type="text" placeholder="Agent name" maxlength="80">
                <button id="agent-create" class="menu_button primary">Add</button>
            </div>
            <div class="sd-agent-list">
                ${agents.length ? agents.map(agent => {
                    const runtime = getAgentRuntimeState(agent.id);
                    const connection = resolveAgentConnection(agent, config);
                    return `
                        <button class="sd-agent-list-item${selectedAgent?.id === agent.id ? ' sd-agent-list-item--active' : ''}" data-agent-id="${escapeHtml(agent.id)}" draggable="true" title="${escapeHtml(agent.name)} — drag to reorder; Alt+Up/Down to move">
                            <i class="fa-solid fa-grip-vertical sd-agent-drag-handle" aria-hidden="true"></i>
                            <span class="sd-agent-list-copy">
                            <span class="sd-agent-list-title-row">
                                <span class="sd-agent-list-name">${escapeHtml(agent.name)}</span>
                                <span class="sd-agent-state-dot sd-agent-state-dot--${escapeHtml(getStatusTone(runtime.lastStatus))}"></span>
                            </span>
                            <span class="sd-agent-list-tag">{{agent:${escapeHtml(agent.id)}}}</span>
                            <span class="sd-agent-list-schedule">${escapeHtml(formatAgentSchedule(agent))}</span>
                            <span class="sd-agent-list-schedule">${escapeHtml(connection.profileName || connection.label)}</span>
                            </span>
                        </button>
                    `;
                }).join('') : `<div class="sd-agent-empty-state"><b>No agents for ${escapeHtml(activeOwner.label)}</b><span>Create one above. It will inherit this owner's connection.</span></div>`}
            </div>
        </aside>
    `;
}

function renderAgentWorkspacePanel(agent) {
    const runtime = getAgentRuntimeState(agent.id);
    const latestLog = getLatestAgentOperation(agent.id);
    const dependencies = getAgentDependencies(agent.prompt);
    const updatedAt = runtime.updatedAt ? formatPanelTime(new Date(runtime.updatedAt)) : 'never';
    const beforeCharacter = agent.scheduleType === 'before-character';
    const turnsUntilRun = agent.scheduleType === 'manual' || beforeCharacter ? '-' : Math.max(0, agent.interval - runtime.pendingTurns);
    const injectionTargets = getAgentInjectionTargets(agent);
    const outputValidation = runtime.output ? validateAgentOutput(agent, runtime.output) : { valid: true, error: '' };
    const injectionSummary = injectionTargets.length
        ? injectionTargets.map(target => `${target.characterName || 'Unknown'} -> ${target.mode === 'full' ? 'Full output' : `[${target.tag}]`}`).join('\n')
        : 'No character destinations configured.';

    const latestError = runtime.lastStatus === 'error'
        ? latestLog?.error || runtime.lastError
        : '';

    return `
        <div class="sd-grid">
            <div class="sd-summary-grid">
                ${renderStatCard('Status', formatStateLabel(runtime.lastStatus), runtime.lastError?.split('\n')[0] || 'Latest persisted state')}
                ${renderStatCard('Pending turns', beforeCharacter ? '-' : String(runtime.pendingTurns), beforeCharacter ? formatAgentSchedule(agent) : agent.scheduleType === 'manual' ? 'Manual schedule' : `${turnsUntilRun} until next run`)}
                ${renderStatCard('Dependencies', String(dependencies.length), dependencies.map(id => `agent:${id}`).join(', ') || 'No agent tags')}
                ${renderStatCard('Last update', updatedAt, runtime.runId || 'No successful run')}
            </div>

            ${renderDisclosure('Agent Output', 'Persistent output available through this agent tag.', `
                <textarea id="agent-output" class="text_pole sd-editor-textarea sd-editor-textarea--tall" spellcheck="false">${escapeHtml(runtime.output)}</textarea>
                ${renderEditorMeta('Stored per chat. Autosaves when focus leaves the field.', 'agent-output-token-counter')}
            `, { open: true })}

            ${agent.actionEnabled || runtime.lastActionStatus !== 'idle'
                ? renderAgentActionResult(agent, { open: runtime.lastActionStatus === 'error' })
                : ''}

            ${renderDisclosure('Output Contract', 'Validation and character delivery for the latest stored output.', `
                <div class="sd-kv"><span>Format validation</span><b>${agent.validateOutputFormat ? (outputValidation.valid ? 'valid' : 'invalid') : 'disabled'}</b></div>
                <div class="sd-kv"><span>Character injection</span><b>${agent.characterInjectionEnabled ? 'enabled' : 'disabled'}</b></div>
                <div class="sd-kv"><span>Placement</span><b>${escapeHtml(formatAgentInjectionPlacement(agent))}</b></div>
                ${renderTokenCountedConsole(injectionSummary)}
                ${outputValidation.valid ? '' : renderTokenCountedConsole(outputValidation.error, '', 'sd-console--error')}
            `)}

            ${renderDisclosure('Reasoning', 'Reasoning captured from the latest execution in this session.', `
                ${renderTokenCountedConsole(latestLog?.reasoning, 'No reasoning captured in this session.', 'sd-console--tall')}
            `)}
            ${renderDisclosure('Context', 'Exact resolved context snapshot recorded for the latest execution.', `
                ${renderTokenCountedConsole(latestLog?.context, 'No context captured in this session.', 'sd-console--tall')}
            `)}
            ${renderDisclosure('Request', 'Messages sent to the selected Connection Profile.', `
                ${renderTokenCountedConsole(latestLog?.request, 'No request captured in this session.', 'sd-console--tall')}
            `)}
            ${latestError ? renderDisclosure('Error', 'Latest execution failure. The previous valid output was preserved.', `
                ${renderTokenCountedConsole(latestError, '', 'sd-console--error')}
            `, { open: true }) : ''}
        </div>
    `;
}

function renderAgentActionResult(agent, { open = false, emptyMessage = 'No JavaScript action has run for this agent in this chat.' } = {}) {
    const runtime = getAgentRuntimeState(agent.id);
    const hasExecution = runtime.lastActionStatus !== 'idle'
        || runtime.lastActionResult
        || runtime.lastActionError
        || runtime.lastActionPayload;
    const executedAt = runtime.lastActionExecutedAt
        ? formatPanelTime(new Date(runtime.lastActionExecutedAt))
        : 'never';
    const body = hasExecution ? `
        <div class="sd-action-result-summary">
            <div class="sd-kv"><span>Status</span><b>${escapeHtml(formatStateLabel(runtime.lastActionStatus))}</b></div>
            <div class="sd-kv"><span>Trigger</span><b>${escapeHtml(runtime.lastActionTrigger || '-')}</b></div>
            <div class="sd-kv"><span>Duration</span><b>${escapeHtml(formatDurationMs(runtime.lastActionDurationMs))}</b></div>
            <div class="sd-kv"><span>Executed</span><b>${escapeHtml(executedAt)}</b></div>
        </div>
        ${runtime.lastActionPayload ? `<div class="sd-log-detail-title">Payload</div>${renderTokenCountedConsole(runtime.lastActionPayload, '')}` : ''}
        ${runtime.lastActionResult ? `<div class="sd-log-detail-title">Result</div>${renderTokenCountedConsole(runtime.lastActionResult, '')}` : ''}
        ${runtime.lastActionLogs ? `<div class="sd-log-detail-title">Script log</div>${renderTokenCountedConsole(runtime.lastActionLogs, '')}` : ''}
        ${runtime.lastActionError ? `<div class="sd-log-detail-title">Error</div>${renderTokenCountedConsole(runtime.lastActionError, '', 'sd-console--error')}` : ''}
    ` : `<div class="sd-muted">${escapeHtml(emptyMessage)}</div>`;

    return renderDisclosure(
        'Action Result',
        'Latest browser-side JavaScript execution for this agent.',
        body,
        { open: open || hasExecution },
    );
}

function renderAgentOocPanel(agent) {
    const history = getAgentOocHistory(agent.id);
    const transcript = formatOocTranscript(history);
    const latestLog = (sceneDirectorState.operationLogs ?? [])
        .find(log => log.agentId === agent.id && log.kind === `agent-ooc:${agent.id}`) ?? null;

    return `
        <div class="sd-grid">
            ${renderDisclosure('Conversation', 'OOC', `
                ${renderTokenCountedConsole(transcript, 'No OOC conversation yet.', 'sd-console--tall')}
                <div class="sd-ooc-composer">
                <textarea id="agent-ooc-request" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(getAgentOocDraft(agent.id))}</textarea>
                <div class="sd-inline-actions">
                    <button id="agent-send-ooc" class="menu_button primary" ${runningAgentIds.has(agent.id) ? 'disabled' : ''}>Send OOC</button>
                    <button id="agent-clear-ooc-draft" class="menu_button">Reset Draft</button>
                    <button id="agent-clear-ooc-history" class="menu_button">Clear Conversation</button>
                </div>
                </div>
            `, { open: true })}

            ${agent.actionEnabled ? `
                <div class="sd-inline-actions">
                    <button id="agent-run-ooc-action" class="menu_button primary" ${getLatestAgentOocAssistantOutput(agent.id) && !runningAgentActionIds.has(agent.id) ? '' : 'disabled'}>Run Action from Latest OOC</button>
                    <span class="sd-muted">OOC responses never execute automatically.</span>
                </div>
                ${renderAgentActionResult(agent)}
            ` : ''}

            ${renderDisclosure('Reasoning', 'Reasoning captured from the latest OOC request in this session.', `
                ${renderTokenCountedConsole(latestLog?.reasoning, 'No OOC reasoning captured in this session.', 'sd-console--tall')}
            `)}
            ${renderDisclosure('Context', 'Resolved context snapshot from the latest OOC request.', `
                ${renderTokenCountedConsole(latestLog?.context, 'No OOC context captured in this session.', 'sd-console--tall')}
            `)}
            ${renderDisclosure('Request', 'Messages sent for the latest OOC request.', `
                ${renderTokenCountedConsole(latestLog?.request, 'No OOC request captured in this session.', 'sd-console--tall')}
            `)}
            ${latestLog?.error ? renderDisclosure('Error', 'Latest OOC request failure.', `
                ${renderTokenCountedConsole(latestLog.error, '', 'sd-console--error')}
            `, { open: true }) : ''}
        </div>
    `;
}

function getLatestAgentOocAssistantOutput(agentId) {
    return [...getAgentOocHistory(agentId)]
        .reverse()
        .find(message => message?.role === 'assistant')?.content ?? '';
}

function renderAgentScriptPanel(agent) {
    const validation = validateAgentActionScript(agent.actionScript);
    return `
        <div class="sd-action-studio">
            <section class="sd-action-editor-pane">
                <div class="sd-action-pane-header">
                    <div>
                        <div class="sd-card-title">JavaScript Action</div>
                        <div class="sd-card-subtitle">Runs inside the SillyTavern page with the agent JSON as <code>payload</code>.</div>
                    </div>
                    <span class="sd-status-badge sd-status-badge--${validation.valid ? 'success' : 'danger'}">${validation.valid ? 'valid' : 'invalid'}</span>
                </div>
                <div id="agent-action-editor" class="sd-code-editor" aria-label="Agent JavaScript action editor"></div>
                <div class="sd-editor-meta">
                    <span>Available: <code>payload</code>, <code>rawOutput</code>, <code>agent</code>, <code>trigger</code>, <code>context</code>, <code>log()</code></span>
                    <span>Saved when focus leaves the editor.</span>
                </div>
            </section>
            <aside class="sd-action-control-pane">
                <label class="sd-checkbox-row" for="agent-action-enabled">
                    <input id="agent-action-enabled" type="checkbox" ${agent.actionEnabled ? 'checked' : ''}>
                    <span>Enable JavaScript action</span>
                </label>
                <label class="sd-checkbox-row" for="agent-action-auto-run">
                    <input id="agent-action-auto-run" type="checkbox" ${agent.actionAutoRun ? 'checked' : ''} ${agent.actionEnabled ? '' : 'disabled'}>
                    <span>Run automatically after normal agent updates</span>
                </label>
                <div class="sd-footnote sd-action-warning">Trusted scripts only. This code runs with access to the current SillyTavern page.</div>
                <div class="sd-footnote">The complete agent response must be valid JSON. Markdown fences are removed before parsing.</div>
                <div class="sd-inline-actions">
                    <button id="agent-action-validate" class="menu_button">Validate</button>
                    <button id="agent-action-test" class="menu_button primary" ${agent.actionEnabled && !runningAgentActionIds.has(agent.id) ? '' : 'disabled'}>Run Test</button>
                </div>
                ${validation.valid ? '' : renderTokenCountedConsole(validation.error, '', 'sd-console--error')}
                <label for="agent-action-test-payload">Test payload</label>
                <textarea id="agent-action-test-payload" class="text_pole sd-action-payload" spellcheck="false">${escapeHtml(agent.actionTestPayload)}</textarea>
                ${renderAgentActionResult(agent, { open: true })}
            </aside>
        </div>
    `;
}

function renderAgentReferenceCharacterOptions(agent, ctx = SillyTavern.getContext()) {
    const characters = [...(Array.isArray(ctx.characters) ? ctx.characters : [])]
        .filter(character => character?.avatar && character?.name)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const selectedAvatar = String(agent.referenceCharacterAvatar ?? '');
    const hasSelectedCharacter = characters.some(character => String(character.avatar) === selectedAvatar);
    const missingSelection = selectedAvatar && !hasSelectedCharacter
        ? `<option value="${escapeHtml(selectedAvatar)}" selected>${escapeHtml(agent.referenceCharacterName || 'Unavailable character')} (unavailable)</option>`
        : '';

    return `
        <option value="">No reference character</option>
        ${missingSelection}
        ${characters.map(character => `
            <option value="${escapeHtml(character.avatar)}" ${String(character.avatar) === selectedAvatar ? 'selected' : ''}>${escapeHtml(character.name)}</option>
        `).join('')}
    `;
}

function renderAgentInjectionCharacterOptions(target, ctx = SillyTavern.getContext()) {
    const characters = [...(Array.isArray(ctx.characters) ? ctx.characters : [])]
        .filter(character => character?.avatar && character?.name)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const selectedAvatar = String(target?.characterAvatar ?? '');
    const selectedName = String(target?.characterName ?? '');
    const hasSelectedCharacter = characters.some(character => String(character.avatar) === selectedAvatar);
    const missingSelection = (selectedAvatar || selectedName) && !hasSelectedCharacter
        ? `<option value="${escapeHtml(selectedAvatar)}" data-character-name="${escapeHtml(selectedName)}" selected>${escapeHtml(selectedName || 'Unavailable character')} (unavailable)</option>`
        : '';

    return `
        <option value="">Select character</option>
        ${missingSelection}
        ${characters.map(character => `
            <option value="${escapeHtml(character.avatar)}" data-character-name="${escapeHtml(character.name)}" ${String(character.avatar) === selectedAvatar ? 'selected' : ''}>${escapeHtml(character.name)}</option>
        `).join('')}
    `;
}

function renderAgentInjectionTargets(agent) {
    const owned = agent.ownerType === AGENT_OWNER_TYPES.CHARACTER;
    const targets = getAgentInjectionTargets(agent);
    if (!targets.length) {
        return '<div class="sd-log-empty">No character destinations configured.</div>';
    }

    return targets.map((target, index) => `
        <div class="sd-agent-injection-target" data-agent-injection-target data-target-index="${index}">
            ${owned ? `<input type="hidden" data-agent-injection-character value="${escapeHtml(target.characterAvatar)}" data-character-name="${escapeHtml(target.characterName)}">` : `<select class="text_pole" data-agent-injection-character>
                ${renderAgentInjectionCharacterOptions(target)}
            </select>`}
            <select class="text_pole" data-agent-injection-mode>
                <option value="tag" ${target.mode === 'tag' ? 'selected' : ''}>Tagged section</option>
                <option value="full" ${target.mode === 'full' ? 'selected' : ''}>Full output</option>
            </select>
            <input class="text_pole" data-agent-injection-tag type="text" value="${escapeHtml(target.tag ? `<${target.tag}>` : '')}" placeholder="<Mirella>" ${target.mode === 'full' ? 'disabled' : ''}>
            <label class="sd-checkbox-row sd-agent-injection-optional"><input type="checkbox" data-agent-injection-optional ${target.optional ? 'checked' : ''} ${target.mode === 'full' ? 'disabled' : ''}><span>Optional block</span></label>
            ${owned ? '' : `<button class="menu_button" data-agent-injection-remove="${index}" title="Remove destination">Remove</button>`}
        </div>
    `).join('');
}

function renderGraphitiPermissionOptions(agent, mode) {
    const automatic = mode === 'automatic';
    const selected = new Set(automatic
        ? agent.graphitiAutomaticPermissions
        : agent.graphitiOocPermissions);
    const labels = {
        search: 'Search',
        remember: 'Remember',
        correct: 'Correct',
        forget: 'Forget',
    };
    return [...GRAPHITI_PERMISSION_TYPES].map(permission => `
        <label class="sd-checkbox-row" for="agent-graphiti-${mode}-${permission}">
            <input
                id="agent-graphiti-${mode}-${permission}"
                type="checkbox"
                data-agent-graphiti-permission="${permission}"
                data-agent-graphiti-mode="${mode}"
                ${selected.has(permission) ? 'checked' : ''}
            >
            <span>${labels[permission]}</span>
        </label>
    `).join('');
}

function renderAgentConfigPanel(agent) {
    const internal = agent.internalType === SUMMARY_CREATION_TYPE;
    const owned = agent.ownerType === AGENT_OWNER_TYPES.CHARACTER;
    const beforeCharacter = agent.scheduleType === 'before-character';
    const characterSchedule = agent.scheduleType === 'character-turns' || beforeCharacter;
    const selectedLorebookCount = Array.isArray(agent.worldInfoBooks) ? agent.worldInfoBooks.length : 0;
    const injectionPlacement = normalizeAgentInjectionPlacement(agent);
    const injectionEnabled = agent.characterInjectionEnabled;
    const inChatPlacement = injectionPlacement.position === AGENT_INJECTION_POSITIONS.IN_CHAT;
    const placementDisabled = injectionEnabled ? '' : 'disabled';
    const depthSettingsDisabled = injectionEnabled && inChatPlacement ? '' : 'disabled';
    const resolvedConnection = resolveAgentConnection(agent, config);
    const usesOwnConnection = agent.connectionMode === AGENT_CONNECTION_MODES.PROFILE;
    return `
        <div class="sd-grid sd-grid--double">
            ${renderCard('Agent Settings', 'Identity, connection and execution cadence.', `
                <label class="sd-checkbox-row" for="agent-enabled">
                    <input id="agent-enabled" type="checkbox" ${agent.enabled ? 'checked' : ''}>
                    <span>Enable automatic execution</span>
                </label>
                ${internal ? '' : `<label>Name</label>
                <input id="agent-name" class="text_pole" type="text" maxlength="80" value="${escapeHtml(agent.name)}">
                <label>Agent ID</label>
                <input id="agent-id" class="text_pole" type="text" maxlength="64" value="${escapeHtml(agent.id)}">
                <div class="sd-footnote">Character agents use <code>character:agent</code>. Changing the ID migrates stored output and prompt references.</div>
                <label>Output tag</label>
                <input class="text_pole" type="text" readonly value="{{agent:${escapeHtml(agent.id)}}}">
                <div class="sd-footnote">The display name can change without changing this tag.</div>`}
                <label>Agent Connection</label>
                <select id="agent-connection-mode" class="text_pole">
                    <option value="parent" ${usesOwnConnection ? '' : 'selected'}>Inherit from ${escapeHtml(getAgentOwnerLabel(agent))}</option>
                    <option value="profile" ${usesOwnConnection ? 'selected' : ''}>Use an agent-specific profile</option>
                </select>
                <div class="sd-connection-resolution">Resolved: <b>${escapeHtml(resolvedConnection.profileName || resolvedConnection.profileId || 'not configured')}</b> via ${escapeHtml(resolvedConnection.label)}</div>
                <select id="agent-profile-dropdown" class="text_pole ${usesOwnConnection ? '' : 'sd-hidden'}"></select>
                ${owned ? '' : `<label>Reference character</label>
                <select id="agent-reference-character" class="text_pole">
                    ${renderAgentReferenceCharacterOptions(agent)}
                </select>
                <div class="sd-footnote">Makes the selected card fields available through prompt tags. Nothing is injected unless a tag is used.</div>`}
                <label>Schedule</label>
                <select id="agent-schedule-type" class="text_pole">
                    <option value="manual" ${agent.scheduleType === 'manual' ? 'selected' : ''}>Manual only</option>
                    <option value="user-turns" ${agent.scheduleType === 'user-turns' ? 'selected' : ''}>User turns</option>
                    <option value="total-turns" ${agent.scheduleType === 'total-turns' ? 'selected' : ''}>Total RP turns</option>
                    <option value="character-turns" ${agent.scheduleType === 'character-turns' ? 'selected' : ''}>Specific character turns</option>
                    <option value="before-character" ${beforeCharacter ? 'selected' : ''}>Before character turn</option>
                </select>
                ${beforeCharacter ? '' : `<label>Turns between updates</label>
                <input id="agent-interval" class="text_pole" type="number" min="1" max="10000" value="${agent.interval}">`}
                ${owned ? '' : `<label>Character name</label>
                <input id="agent-character-name" class="text_pole" type="text" value="${escapeHtml(agent.characterName)}" ${characterSchedule ? '' : 'disabled'} placeholder="Exact or first name">`}
                <label>Recent RP messages available to {{recentChat}} and {{recentCharChat}}</label>
                <input id="agent-context-messages" class="text_pole" type="number" min="1" max="5000" value="${agent.contextMessages}">
                <label for="agent-context-message-offset">Final message offset</label>
                <input id="agent-context-message-offset" class="text_pole" type="number" min="0" step="1" value="${normalizeContextMessageOffset(agent.contextMessageOffset)}">
                <div id="agent-recent-chat-tokens" class="sd-footnote" aria-live="polite">Current chat: calculating...</div>
                <label class="sd-checkbox-row"><input id="agent-include-hidden" type="checkbox" ${agent.includeHiddenMessages ? 'checked' : ''}><span>Include hidden RP messages</span></label>
                <label class="sd-checkbox-row"><input id="agent-apply-prompt-regex" type="checkbox" ${agent.applyPromptRegex ? 'checked' : ''}><span>Apply ST prompt regex to recent messages</span></label>
                <label>Maximum tool-call rounds</label>
                <input id="agent-max-tool-rounds" class="text_pole" type="number" min="1" max="${MAX_AGENT_TOOL_ROUNDS}" value="${agent.maxToolRounds}">
                <div class="sd-footnote">Shared by automatic and OOC runs. A round may contain multiple tool calls before the agent returns its final answer.</div>
                <label for="agent-log-level">Console log level</label>
                <select id="agent-log-level" class="text_pole">
                    ${renderLogLevelOptions(agent.logLevel, { includeInherit: true })}
                </select>
                <div class="sd-footnote">Overrides the global console level only for <code>[${escapeHtml(getAgentLogScope(agent))}]</code>. Operation History is never disabled.</div>
            `)}
            ${renderCard('Prompt Template', 'The complete system prompt for this specialized agent.', `
                <div class="sd-template-tags">
                    <code>{{recentChat}}</code><code>{{recentCharChat}}</code><code>{{previousOutput}}</code><code>{{user}}</code>
                    <code>{{lastSpeaker}}</code><code>{{trigger}}</code><code>{{agent:id}}</code>
                    <code>{{characterPersonality}}</code><code>{{characterScenario}}</code><code>{{characterCreatorNotes}}</code><code>{{characterSummary}}</code>
                    <code>{{characterPersonality:Name}}</code>
                    <code>{{lorebookContext}}</code><code>{{lorebookCatalog}}</code>
                </div>
                <textarea id="agent-prompt" class="text_pole sd-editor-textarea sd-editor-textarea--tall" spellcheck="false">${escapeHtml(agent.prompt)}</textarea>
                ${renderEditorMeta('Dependencies are detected from {{agent:id}} tags. Autosaves on blur.', 'agent-prompt-token-counter')}
            `)}
            ${internal ? '' : renderCard('Output Contract', 'Validate the response and route the latest valid output into character prompts.', `
                <label class="sd-checkbox-row" for="agent-validate-output-format">
                    <input id="agent-validate-output-format" type="checkbox" ${agent.validateOutputFormat ? 'checked' : ''}>
                    <span>Validate XML tags from the final OUTPUT FORMAT section</span>
                </label>
                <label class="sd-checkbox-row" for="agent-character-injection-enabled">
                    <input id="agent-character-injection-enabled" type="checkbox" ${agent.characterInjectionEnabled ? 'checked' : ''}>
                    <span>${owned ? `Inject output into ${escapeHtml(getAgentOwnerLabel(agent))}` : 'Inject output into characters'}</span>
                </label>
                <div class="floating_prompt_radio_group ${injectionEnabled ? '' : 'sd-control-disabled'}">
                    <label class="checkbox_label" for="agent-injection-position-before">
                        <input id="agent-injection-position-before" type="radio" name="agent-injection-position" value="${AGENT_INJECTION_POSITIONS.BEFORE_MAIN}" ${injectionPlacement.position === AGENT_INJECTION_POSITIONS.BEFORE_MAIN ? 'checked' : ''} ${placementDisabled}>
                        <span>Before Main Prompt / Story String</span>
                    </label>
                    <label class="checkbox_label" for="agent-injection-position-after">
                        <input id="agent-injection-position-after" type="radio" name="agent-injection-position" value="${AGENT_INJECTION_POSITIONS.AFTER_MAIN}" ${injectionPlacement.position === AGENT_INJECTION_POSITIONS.AFTER_MAIN ? 'checked' : ''} ${placementDisabled}>
                        <span>After Main Prompt / Story String</span>
                    </label>
                    <label class="checkbox_label alignItemsCenter" for="agent-injection-position-depth">
                        <input id="agent-injection-position-depth" type="radio" name="agent-injection-position" value="${AGENT_INJECTION_POSITIONS.IN_CHAT}" ${inChatPlacement ? 'checked' : ''} ${placementDisabled}>
                        <span>In-chat @ Depth</span>
                        <input id="agent-injection-depth" class="text_pole textarea_compact widthNatural" type="number" min="0" max="9999" value="${injectionPlacement.depth}" ${depthSettingsDisabled}>
                        <span>as</span>
                        <select id="agent-injection-role" class="text_pole widthNatural" ${depthSettingsDisabled}>
                            <option value="0" ${injectionPlacement.role === 0 ? 'selected' : ''}>System</option>
                            <option value="1" ${injectionPlacement.role === 1 ? 'selected' : ''}>User</option>
                            <option value="2" ${injectionPlacement.role === 2 ? 'selected' : ''}>Assistant</option>
                        </select>
                    </label>
                </div>
                <div class="sd-footnote">Depth 0 inserts after the newest chat message. Before/After Main always use the System role.</div>
                <div id="agent-injection-targets" class="sd-agent-injection-targets ${agent.characterInjectionEnabled ? '' : 'sd-control-disabled'}">
                    ${renderAgentInjectionTargets(agent)}
                </div>
                ${owned ? '' : `<div class="sd-inline-actions">
                    <button id="agent-injection-add" class="menu_button" ${agent.characterInjectionEnabled ? '' : 'disabled'}>Add destination</button>
                </div>`}
                <div class="sd-footnote">Use valid, case-sensitive XML names such as &lt;Mirella&gt; or &lt;Tio_Klarus&gt;. Each destination must appear exactly once in the final OUTPUT FORMAT and response. Tagged section removes only that outer tag; Full output injects the entire validated payload.</div>
            `)}
            ${renderCard('Knowledge Context', 'Configure long-term memory tools and direct lorebook context.', `
                ${internal ? '' : `<label class="sd-checkbox-row" for="agent-graphiti-ooc-enabled">
                    <input id="agent-graphiti-ooc-enabled" type="checkbox" ${agent.graphitiOocEnabled ? 'checked' : ''}>
                    <span>Enable long-term memory (RAG) tools in OOC</span>
                </label>
                <label class="sd-checkbox-row" for="agent-graphiti-automatic-enabled">
                    <input id="agent-graphiti-automatic-enabled" type="checkbox" ${agent.graphitiAutomaticEnabled ? 'checked' : ''}>
                    <span>Enable long-term memory (RAG) tools during normal agent runs</span>
                </label>
                <label>Readable memory groups</label>
                <textarea id="agent-graphiti-read-groups" class="text_pole sd-editor-textarea" rows="2" spellcheck="false" placeholder="rp-arifureta-char-mirella">${escapeHtml(agent.graphitiReadGroupIds.join('\n'))}</textarea>
                <div class="sd-footnote">One group per line. IDs allow only letters, numbers, dashes and underscores.</div>
                <label>Writable memory group</label>
                <input id="agent-graphiti-write-group" class="text_pole" type="text" value="${escapeHtml(agent.graphitiWriteGroupId)}" placeholder="rp-arifureta-char-mirella">
                <label>OOC permissions</label>
                <div class="sd-checkbox-list">
                    ${renderGraphitiPermissionOptions(agent, 'ooc')}
                </div>
                <label>Automatic-run permissions</label>
                <div class="sd-checkbox-list">
                    ${renderGraphitiPermissionOptions(agent, 'automatic')}
                </div>
                <div class="sd-footnote">Status is always available when memory tools are enabled. Search is restricted to readable groups. Remember, Correct and Forget are restricted to the single writable group. Every tool round appears in Operation History.</div>`}
                <div class="sd-inline-actions">
                    <button id="agent-world-info-all" class="menu_button">Select All</button>
                    <button id="agent-world-info-none" class="menu_button">Clear All</button>
                    <span id="agent-world-info-count" class="sd-muted">${selectedLorebookCount} selected</span>
                </div>
                <div id="agent-world-info-books" class="sd-checkbox-list"></div>
                <div class="sd-footnote"><code>{{lorebookContext}}</code> resolves activated entries. <code>{{lorebookCatalog}}</code> resolves every entry from the selected books.</div>
            `)}
            ${internal ? '' : `<div class="sd-agent-danger-zone">
                <div>
                    <div class="sd-card-title">Delete agent</div>
                    <div class="sd-card-subtitle">Removes the global definition and this chat's stored output.</div>
                </div>
                <button id="agent-delete" class="menu_button danger">Delete</button>
            </div>`}
        </div>
    `;
}

function renderAgentViewPanel(agent, view) {
    if (view === 'config') return renderAgentConfigPanel(agent);
    if (view === 'ooc') return renderAgentOocPanel(agent);
    if (view === 'script') return renderAgentScriptPanel(agent);
    return renderAgentWorkspacePanel(agent);
}

function switchAgentView(nextView) {
    const view = ['workspace', 'ooc', 'script', 'config'].includes(nextView) ? nextView : 'workspace';
    const agent = getSelectedAgent();
    preserveVisiblePanelDrafts();
    sceneDirectorState.agentView = view;

    $('#scene-director-panel-body [data-agent-view]')
        .removeClass('sd-subnav-button--active')
        .attr('aria-pressed', 'false')
        .filter(`[data-agent-view="${view}"]`)
        .addClass('sd-subnav-button--active')
        .attr('aria-pressed', 'true');
    $('#scene-director-panel-body [data-agent-workspace-action]')
        .toggleClass('sd-hidden', view !== 'workspace');

    const content = $('#scene-director-panel-body .sd-agent-content');
    if (!content.length) {
        refreshSceneDirectorPanel();
        return;
    }

    destroyTextEditors();
    content.html(agent
        ? renderAgentViewPanel(agent, view)
        : '<div class="sd-agent-empty"><h4>Create the first agent</h4><p>Give it a name, assign a Connection Profile and write one focused task.</p></div>');
    const contentElement = content.get(0);
    if (contentElement) contentElement.scrollTop = 0;

    if (agent && view === 'config') {
        initAgentProfileDropdown();
        initAgentWorldInfoSelect();
    } else if (agent && view === 'script') {
        initAgentScriptEditor(agent);
    }
    refreshVisiblePromptTokenCounters();
    initAgentContentTabs();
}

function initAgentContentTabs() {
    const agent = getSelectedAgent();
    const root = document.querySelector('#scene-director-panel .sd-agent-content > .sd-grid');
    const navigationRoot = document.querySelector('#scene-director-panel .sd-agent-section-navigation');
    const navigation = document.querySelector('#scene-director-panel .sd-agent-navigation');
    const summary = document.querySelector('#scene-director-panel .sd-memory-summary');
    if (summary && navigation) {
        const creationTab = [...summary.querySelectorAll(':scope > .sd-section-tabs > .sd-section-tab')]
            .find(button => button.textContent === 'Creation');
        if (creationTab) {
            creationTab.after(navigation);
            navigation.hidden = creationTab.getAttribute('aria-selected') !== 'true';
        }
    }
    if (!root) navigationRoot?.replaceChildren();
    if (agent && root) {
        mountSectionTabs(root, {
            key: `${agent.id}:${sceneDirectorState.agentView}`,
            navigationRoot,
            orientation: 'vertical',
            defaultLabel: sceneDirectorState.agentView === 'config' ? 'Prompt' : 'Output',
            onSelect: () => {
                refreshVisiblePromptTokenCounters();
                refreshAgentRecentChatTokenCount();
                mountVisibleTextEditors();
                window.dispatchEvent(new Event('resize'));
            },
        });
    }
    nestAgentSectionNavigation(navigation);
    mountVisibleTextEditors();
}

function mountVisibleTextEditors() {
    mountTextEditors(document.getElementById('scene-director-panel-body')).catch(error => {
        backstageLogger.warn('UI', 'Text editor unavailable; using the original text fields', error);
    });
}

/** Keep confirmed out-of-box recalls visible until the operator dismisses them. */
function notifyOutsideMemoryUse(event) {
    if (event.stage !== 'outside-memory-used') return;
    const text = String(event.text ?? '').replace(/\s+/g, ' ').trim();
    const percent = value => `${(value * 100).toFixed(1)}%`;
    toastr.info(`${text.slice(0, 220)}${text.length > 220 ? '...' : ''}\nP(used): ${percent(event.result.usage_probability)} | Confidence: ${percent(event.result.confidence)}`,
        `Memory used outside box: ${event.character}`, {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false, escapeHtml: true,
        });
}

const memoryReinforcementLogger = createMemoryReinforcementLogger({ appendOperationLog, updateOperationLog, completeOperationLog,
    isProgressEnabled: () => config.memorySearchLogs !== false });
const memoryReinforcement = createMemoryReinforcement({
    getContext: () => SillyTavern.getContext(),
    getCharacters: () => config.enabled ? config.characters : [],
    isOocMessage: isBackstageOocMessage,
    onEvent: event => {
        memoryReinforcementLogger(event);
        notifyOutsideMemoryUse(event);
    },
});

const summaryCreation = createSummaryCreation({
    getContext: () => SillyTavern.getContext(),
    getCharacter: value => config.characters.find(character =>
        (value.ownerCharacterAvatar || value.avatar)
            ? character.avatar === (value.ownerCharacterAvatar || value.avatar)
            : character.name === (value.ownerCharacterName || value.name)),
    selectMessages: (agent, ctx) => getRpContextMessages(ctx.chat, agent.includeHiddenMessages),
    onEvent: event => {
        const id = getActiveOperationLogId(`agent:${event.agentId}`);
        if (id) appendOperationLogDetail(id, `${event.stage}\n${JSON.stringify(event, null, 2)}`);
        backstageLogger.info(`MemoryCreation:${event.agentId}`, event.stage, event);
    },
});
const characterSummaryPanel = createCharacterSummaryPanel({
    getContext: () => SillyTavern.getContext(),
    getOwner: getActiveAgentOwner,
    saveConfig,
    refresh: refreshSceneDirectorPanel,
    reportError: recordBackstageIssue,
    escapeHtml,
    getReinforcementStatus: character => memoryReinforcement.getStatus(character),
    stopReinforcement: character => memoryReinforcement.stop(character),
    renderCreation: renderSummaryCreationPanel,
    refreshTokens: refreshVisiblePromptTokenCounters,
    onTabSelected: label => {
        const agent = getSelectedAgent();
        if (label === 'Creation' && agent && sceneDirectorState.agentView === 'config') {
            initAgentProfileDropdown();
            initAgentWorldInfoSelect();
        }
        initAgentContentTabs();
        refreshAgentRecentChatTokenCount();
    },
});

function getSummaryCreationAgent(character) {
    const existing = config.agents.find(agent => agent.internalType === SUMMARY_CREATION_TYPE
        && (character.avatar ? agent.ownerCharacterAvatar === character.avatar : agent.ownerCharacterName === character.name));
    if (existing) return existing;
    const agent = normalizeAgentDefinition({ id: createUniqueAgentId(`memory-creation:${character.name}`),
        name: 'Memory creation', internalType: SUMMARY_CREATION_TYPE, ownerType: 'character',
        ownerCharacterAvatar: character.avatar, ownerCharacterName: character.name, connectionMode: 'parent',
        enabled: false, scheduleType: 'manual', contextMessages: 50, prompt: DEFAULT_SUMMARY_CREATION_PROMPT });
    config.agents.push(agent);
    saveConfig();
    return agent;
}

async function refreshSummaryAfterCreation(agent, ctx, logId, signal) {
    const character = findCharacterConnection(agent, config.characters);
    try {
        const summary = await fetchCharacterSummary(character, { currentMessageIndex: ctx.chat.length, signal });
        if (SillyTavern.getContext().chatMetadata !== ctx.chatMetadata) return;
        await saveCharacterSummary(ctx, character, summary);
    } catch (error) {
        if (signal?.aborted) throw error;
        appendOperationLogDetail(logId, `Memories saved, but summary refresh failed: ${error.message}`);
    }
}

function renderSummaryCreationPanel(character) {
    const agent = getSummaryCreationAgent(character);
    const view = ['workspace', 'ooc', 'config'].includes(sceneDirectorState.agentView) ? sceneDirectorState.agentView : 'config';
    const state = summaryCreation.getState(agent);
    return `<section class="sd-agent-detail-pane sd-summary-creation">
        <div class="sd-agent-detail-heading"><b>Memory creation</b>${renderStatusBadge(getAgentRuntimeState(agent.id).lastStatus)}</div>
        <div class="sd-agent-navigation"><nav class="sd-agent-view-tabs" aria-label="Memory creation views">${['workspace', 'ooc', 'config'].map(tab => `<button type="button" class="sd-subnav-button${view === tab ? ' sd-subnav-button--active' : ''}" data-agent-view="${tab}" aria-pressed="${view === tab}">${{ workspace: 'Workspace', ooc: 'OOC', config: 'Config' }[tab]}</button>`).join('')}</nav><div class="sd-agent-section-navigation"></div></div>
        <div class="sd-agent-toolbar"><button id="agent-run" class="menu_button" ${runningAgentIds.has(agent.id) || state?.pending ? 'disabled' : ''}>Create memories</button>${runningAgentIds.has(agent.id) ? '<button data-agent-stop class="menu_button">Stop</button>' : ''}${state?.pending ? `<button data-summary-creation-retry class="menu_button" ${runningAgentIds.has(agent.id) ? 'disabled' : ''}>Retry Save</button>` : ''}<span class="sd-muted">${state?.pending ? `Pending save: ${state.pending.saved.length}/${state.pending.bodies.length}` : state?.lastBatch ? `${state.lastBatch.count} saved · through message ${state.lastSavedIndex}` : 'No memories created yet'}</span></div>
        <div class="sd-agent-content">${renderAgentViewPanel(agent, view)}</div>
    </section>`;
}

function renderCharacterSummary(activeOwner) {
    return characterSummaryPanel.render(activeOwner);
}

function renderAgentsWorkspace() {
    const activeOwner = getActiveAgentOwner();
    const agent = getSelectedAgent();
    const view = ['workspace', 'ooc', 'script', 'config'].includes(sceneDirectorState.agentView)
        ? sceneDirectorState.agentView
        : 'workspace';
    const runtime = agent ? getAgentRuntimeState(agent.id) : null;
    const snapshots = runtime?.snapshots ?? [];
    const summaryView = sceneDirectorState.characterView === 'summary';
    return `
        <div class="sd-main sd-main--agents">
            ${renderPersistentIssueBanner()}
            <div class="sd-character-workbench">
                <div class="sd-character-body">
                    <header class="sd-character-heading">${renderCharacterPicker(activeOwner)}<span>${getAgentsForOwner(activeOwner.key).length} agents <button type="button" class="sd-editor-tool" data-character-connections aria-controls="character-connections" aria-expanded="${sceneDirectorState.characterConnectionsOpen}" title="Connections" aria-label="Connections"><i class="fa-solid fa-plug" aria-hidden="true"></i></button></span></header>
                    ${renderCharacterConnections(activeOwner)}
                    <div class="sd-character-tabs" role="tablist" aria-label="Character workspace">
                        <button type="button" role="tab" id="character-summary-tab" aria-controls="character-workspace" aria-selected="${summaryView}" data-character-view="summary">Summary</button>
                        <button type="button" role="tab" id="character-agents-tab" aria-controls="character-workspace" aria-selected="${!summaryView}" data-character-view="agents">Agents</button>
                    </div>
                    <div id="character-workspace" class="sd-character-stage" role="tabpanel" aria-labelledby="character-${summaryView ? 'summary' : 'agents'}-tab">
                    ${summaryView ? renderCharacterSummary(activeOwner) : `
                    <div class="sd-agent-workbench">
                        ${renderAgentList(agent, activeOwner)}
                <section class="sd-agent-detail-pane">
                    <div class="sd-agent-detail-heading"><div><b>${agent ? escapeHtml(agent.name) : 'Agents'}</b>${agent ? `<span class="sd-agent-tag">{{agent:${escapeHtml(agent.id)}}}</span>` : ''}</div><span class="sd-agent-detail-tools">${agent ? `<button type="button" class="sd-editor-tool" data-agent-move="-1" title="Move agent up" aria-label="Move agent up" ${getAgentsForOwner()[0]?.id === agent.id ? 'disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" class="sd-editor-tool" data-agent-move="1" title="Move agent down" aria-label="Move agent down" ${getAgentsForOwner().at(-1)?.id === agent.id ? 'disabled' : ''}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>` : ''}${renderStatusBadge(runtime?.lastStatus || 'idle')}</span></div>
                    <div class="sd-agent-navigation">
                        <nav class="sd-agent-view-tabs" aria-label="Agent views">
                            ${['workspace', 'ooc', 'config', 'script'].map(tab => `<button type="button" class="sd-subnav-button${view === tab ? ' sd-subnav-button--active' : ''}" data-agent-view="${tab}" aria-pressed="${view === tab}">${({workspace:'Workspace', ooc:'OOC', config:'Config', script:'Script'})[tab]}</button>`).join('')}
                        </nav>
                        <div class="sd-agent-section-navigation"></div>
                    </div>
                    <div class="sd-agent-toolbar">
                        ${agent ? `<button id="agent-run" data-agent-workspace-action class="menu_button primary${view === 'workspace' ? '' : ' sd-hidden'}" ${runningAgentIds.has(agent.id) ? 'disabled' : ''}>Run Now</button>` : ''}
                        ${agent && runningAgentIds.has(agent.id) ? '<button data-agent-stop class="menu_button">Stop</button>' : ''}
                        ${agent?.actionEnabled ? `<button id="agent-run-action" data-agent-workspace-action class="menu_button${view === 'workspace' ? '' : ' sd-hidden'}" ${runtime?.output && !runningAgentIds.has(agent.id) && !runningAgentActionIds.has(agent.id) ? '' : 'disabled'}>Run Action</button>` : ''}
                        ${agent ? `<button id="agent-copy-output" data-agent-workspace-action class="menu_button${view === 'workspace' ? '' : ' sd-hidden'}">Copy Output</button>` : ''}
                        ${agent ? `<details data-agent-workspace-action class="sd-snapshot-menu${view === 'workspace' ? '' : ' sd-hidden'}"><summary>Snapshots</summary><div>${[0, 1, 2].map(index => `<button data-agent-copy-snapshot="${index}" class="menu_button" ${snapshots.length <= index ? 'disabled' : ''} title="${snapshots[index]?.savedAt ? escapeHtml(new Date(snapshots[index].savedAt).toLocaleString()) : 'No snapshot'}">Snapshot ${index + 1}</button>`).join('')}</div></details>` : ''}
                        ${agent ? `<button id="agent-clear-output" data-agent-workspace-action class="menu_button${view === 'workspace' ? '' : ' sd-hidden'}">Clear Output</button>` : ''}
                    </div>
                    <div class="sd-agent-content">
                        ${agent
                            ? renderAgentViewPanel(agent, view)
                            : `<div class="sd-agent-empty"><h4>No agent in ${escapeHtml(activeOwner.label)}</h4><p>Create one from the middle column to start configuring this owner.</p></div>`}
                    </div>
                </section>
                    </div>`}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderMemoryWorkspace() {
    const state = sceneDirectorState.memoryWorkspace;
    const progress = state.total ? `${state.completed}/${state.total}` : '0/0';
    return `
        <div class="sd-main sd-main--memory">
            ${renderPersistentIssueBanner()}
            <section class="sd-hero">
                <div>
                    <div class="sd-eyebrow">Knowledge Operations</div>
                    <h3>Memory</h3>
                    <p>Bootstrap semantic memory from canonical character cards and lorebook entries, with an explicit destination and observable progress.</p>
                </div>
                <div class="sd-hero-meta">
                    ${renderStatusBadge(state.status)}
                    <div class="sd-hero-note">${escapeHtml(progress)} episodes</div>
                </div>
            </section>
            <div class="sd-grid sd-grid--double">
                ${renderCard('Destination', 'Every selected source is written as an independent semantic episode.', `
                    <label>Memory group</label>
                    <input id="memory-group-id" class="text_pole" type="text" value="${escapeHtml(state.groupId)}" placeholder="rp-arifureta-canon">
                    <label>Source description</label>
                    <input id="memory-source-description" class="text_pole" type="text" value="${escapeHtml(state.sourceDescription)}">
                    <div class="sd-inline-actions">
                        <button id="memory-check-status" class="menu_button">Check RAG</button>
                        <button id="memory-ingest" class="menu_button primary" ${state.status === 'running' ? 'disabled' : ''}>Ingest selected</button>
                        ${state.status === 'running' ? '<button id="memory-stop" class="menu_button">Stop</button>' : ''}
                    </div>
                    <div class="sd-footnote">Character cards and lorebook entries are separate episodes. Re-running the same unchanged source uses a deterministic idempotency key.</div>
                `)}
                ${renderCard('Sources', 'Select the canonical material that belongs in this memory group.', `
                    <label>Character cards</label>
                    <div id="memory-source-characters" class="sd-checkbox-list"></div>
                    <label>Lorebooks</label>
                    <div id="memory-source-lorebooks" class="sd-checkbox-list"></div>
                `)}
            </div>
            ${renderDisclosure('Ingestion Activity', state.current || 'Latest result and API response.', `
                <div class="sd-summary-grid">
                    ${renderStatCard('Status', formatStateLabel(state.status), state.current || 'No active source')}
                    ${renderStatCard('Completed', String(state.completed), `${state.total} total episodes`)}
                    ${renderStatCard('Characters', String(state.selectedCharacterAvatars.length), 'Selected cards')}
                    ${renderStatCard('Lorebooks', String(state.selectedLorebooks.length), 'Selected catalogs')}
                </div>
                ${state.error ? renderTokenCountedConsole(state.error, '', 'sd-console--error') : ''}
                ${state.result ? renderTokenCountedConsole(state.result, '', 'sd-console--tall') : ''}
            `, { open: state.status === 'running' || state.status === 'error' })}
        </div>
    `;
}

function getAgentOperationMetrics() {
    const logs = (sceneDirectorState.operationLogs ?? []).filter(log => String(log.kind ?? '').startsWith('agent:'));
    return config.agents.map(agent => {
        const rows = logs.filter(log => log.agentId === agent.id && log.status !== 'running');
        const successes = rows.filter(log => log.status === 'success').length;
        const durations = rows.map(log => Number(log.durationMs)).filter(Number.isFinite);
        const tokens = rows.map(log => Number(log.inputTokens)).filter(Number.isFinite);
        return {
            agent,
            runs: rows.length,
            successRate: rows.length ? Math.round((successes / rows.length) * 100) : 0,
            averageMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
            averageTokens: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) / tokens.length : 0,
        };
    });
}

function renderEvaluationWorkspace() {
    const state = sceneDirectorState.evaluationWorkspace;
    const metrics = getAgentOperationMetrics();
    return `
        <div class="sd-main">
            <section class="sd-hero">
                <div>
                    <div class="sd-eyebrow">Quality Control</div>
                    <h3>Evaluation</h3>
                    <p>Inspect operational agent behavior and run controlled semantic retrieval checks against one or more memory groups.</p>
                </div>
                <div class="sd-hero-meta">
                    ${renderStatusBadge(state.status)}
                    <div class="sd-hero-note">${state.durationMs ? formatDurationMs(state.durationMs) : 'No retrieval test yet'}</div>
                </div>
            </section>
            ${renderCard('Agent Metrics', 'Session-level execution measurements. Quality evaluation stays centralized so agents remain comparable.', `
                <div class="sd-metric-table">
                    <div class="sd-metric-row sd-metric-row--head"><span>Agent</span><span>Owner</span><span>Runs</span><span>Success</span><span>Avg time</span><span>Avg input</span></div>
                    ${metrics.length ? metrics.map(metric => `
                        <div class="sd-metric-row">
                            <span>${escapeHtml(metric.agent.name)}</span>
                            <span>${escapeHtml(getAgentOwnerLabel(metric.agent))}</span>
                            <span>${metric.runs}</span>
                            <span>${metric.runs ? `${metric.successRate}%` : '-'}</span>
                            <span>${metric.runs ? formatDurationMs(metric.averageMs) : '-'}</span>
                            <span>${metric.averageTokens ? Math.round(metric.averageTokens).toLocaleString() : '-'}</span>
                        </div>
                    `).join('') : '<div class="sd-log-empty">No agents configured.</div>'}
                </div>
            `)}
            <div class="sd-grid sd-grid--double">
                ${renderCard('Semantic Retrieval Test', 'A direct RAG query without agent prompting or hidden context.', `
                    <label>Query</label>
                    <textarea id="evaluation-query" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(state.query)}</textarea>
                    <label>Readable groups</label>
                    <textarea id="evaluation-group-ids" class="text_pole" rows="3" spellcheck="false" placeholder="one group per line">${escapeHtml(state.groupIds)}</textarea>
                    <label>Top K</label>
                    <input id="evaluation-count" class="text_pole" type="number" min="1" max="50" value="${state.count}">
                    <button id="evaluation-run" class="menu_button primary" ${state.status === 'running' ? 'disabled' : ''}>Run retrieval</button>
                `)}
                ${renderCard('Retrieval Result', 'Raw facts returned by the memory service for inspection.', `
                    <div class="sd-kv"><span>Status</span><b>${escapeHtml(formatStateLabel(state.status))}</b></div>
                    <div class="sd-kv"><span>Latency</span><b>${state.durationMs ? escapeHtml(formatDurationMs(state.durationMs)) : '-'}</b></div>
                    ${state.error ? renderTokenCountedConsole(state.error, '', 'sd-console--error') : ''}
                    ${renderTokenCountedConsole(state.result, 'No retrieval result yet.', 'sd-console--tall')}
                `)}
            </div>
        </div>
    `;
}

async function initMemorySourceSelects() {
    const state = sceneDirectorState.memoryWorkspace;
    const characterContainer = $('#memory-source-characters');
    const lorebookContainer = $('#memory-source-lorebooks');
    if (characterContainer.length) {
        characterContainer.html((SillyTavern.getContext().characters ?? [])
            .filter(character => character?.avatar && character?.name)
            .sort((left, right) => String(left.name).localeCompare(String(right.name)))
            .map((character, index) => `<label class="sd-checkbox-row" for="memory-character-${index}">
                <input id="memory-character-${index}" type="checkbox" value="${escapeHtml(character.avatar)}" ${state.selectedCharacterAvatars.includes(String(character.avatar)) ? 'checked' : ''}>
                <span>${escapeHtml(character.name)}</span>
            </label>`).join('') || '<div class="sd-muted">No character cards found.</div>');
    }
    if (lorebookContainer.length) {
        try {
            const wi = await getWorldInfoModule();
            lorebookContainer.html(getAvailableWorldInfoNames(wi).map((name, index) => `<label class="sd-checkbox-row" for="memory-lorebook-${index}">
                <input id="memory-lorebook-${index}" type="checkbox" value="${escapeHtml(name)}" ${state.selectedLorebooks.includes(name) ? 'checked' : ''}>
                <span>${escapeHtml(name)}</span>
            </label>`).join('') || '<div class="sd-muted">No lorebooks found.</div>');
        } catch (error) {
            lorebookContainer.html(`<div class="sd-console sd-console--error">${escapeHtml(error?.message ?? String(error))}</div>`);
        }
    }
}

function renderWorkspaceNav() {
    const errorCount = (sceneDirectorState.operationLogs ?? []).filter(log => log.status === 'error').length;
    const items = [
        {
            key: 'router',
            title: ROUTER_LABEL,
            copy: 'Choose the next speaker, inspect context and validate routing output.',
        },
        {
            key: 'agents',
            title: 'Characters',
            copy: 'Configure focused agents, schedules, outputs and dependencies.',
        },
        {
            key: 'memory',
            title: 'Memory',
            copy: 'Ingest canonical cards and lorebooks into semantic memory.',
        },
        {
            key: 'evaluation',
            title: 'Evaluation',
            copy: 'Compare agent operations and test semantic retrieval.',
        },
        {
            key: 'logs',
            title: 'Logs',
            copy: 'Inspect timing, requests, reasoning and failures by operation.',
            badge: errorCount ? String(errorCount) : '',
        },
    ];

    return `
        <aside class="sd-sidebar">
            <div class="sd-sidebar-title">${escapeHtml(EXTENSION_DISPLAY_NAME)}</div>
            <div class="sd-sidebar-copy">Turn routing, focused agents, semantic memory and quality diagnostics.</div>
            <div class="sd-stage-nav">
                ${items.map(item => `
                    <button class="sd-stage-link ${sceneDirectorState.activeTab === item.key ? 'sd-stage-link--active' : ''}" data-stage="${item.key}">
                        <span class="sd-stage-title-row">
                            <span class="sd-stage-name">${escapeHtml(item.title)}</span>
                            ${item.badge ? `<span class="sd-stage-alert">${escapeHtml(item.badge)}</span>` : ''}
                        </span>
                        <span class="sd-stage-copy">${escapeHtml(item.copy)}</span>
                    </button>
                `).join('')}
            </div>
        </aside>
    `;
}

function renderOperationLogDetail(label, value, extraClass = '') {
    const content = String(value ?? '').trim();
    if (!content) return '';

    return `
        <section class="sd-log-detail">
            <div class="sd-log-detail-title">${escapeHtml(label)}</div>
            ${renderTokenCountedConsole(content, '', extraClass)}
        </section>
    `;
}

function renderOperationLogEntry(log) {
    const startedAt = log?.startedAt ? new Date(log.startedAt) : new Date();
    const duration = log?.durationMs != null ? formatDurationMs(log.durationMs) : '0.0s';
    const inputTokens = log?.inputTokens != null && Number.isFinite(Number(log.inputTokens))
        ? Math.round(Number(log.inputTokens)).toLocaleString()
        : '-';
    const hasDetails = !!(
        String(log?.detail ?? '').trim()
        || String(log?.error ?? '').trim()
        || String(log?.context ?? '').trim()
        || String(log?.request ?? '').trim()
        || String(log?.response ?? '').trim()
        || String(log?.reasoning ?? '').trim()
    );

    return `
        <details class="sd-log-entry" data-operation-log-id="${escapeHtml(log?.id || '')}"${hasDetails ? '' : ' data-empty="true"'}>
            <summary class="sd-log-row">
                <span>${escapeHtml(formatPanelTime(startedAt))}</span>
                <span title="${escapeHtml(log?.step || '-')}">${escapeHtml(log?.step || '-')}</span>
                <span title="${escapeHtml(log?.model || '-')}">${escapeHtml(log?.model || '-')}</span>
                <span title="Estimated input tokens">${escapeHtml(inputTokens)}</span>
                <span class="sd-log-duration" data-log-started-at="${log?.status === 'running' ? startedAt.getTime() : ''}">${escapeHtml(duration)}</span>
                <span class="sd-log-status-cell">
                    ${renderStatusBadge(log?.status || 'idle')}
                    ${hasDetails ? '<span class="sd-log-expand">+</span>' : ''}
                </span>
            </summary>
            ${hasDetails ? '<div class="sd-log-entry-body" data-operation-log-body></div>' : ''}
        </details>
    `;
}

function renderOperationLogBody(log) {
    return `
        ${log?.detail ? `<div class="sd-log-context${log.kind === 'memory-boost' ? ' sd-log-context--memory' : ''}">${escapeHtml(log.detail)}</div>` : ''}
        ${renderOperationLogDetail('Error', log?.error, 'sd-console--error')}
        ${renderOperationLogDetail('Context', log?.context)}
        ${renderOperationLogDetail('Request', log?.request)}
        ${renderOperationLogDetail('Response', log?.response)}
        ${renderOperationLogDetail('Reasoning', log?.reasoning)}
    `;
}

function renderLogLevelOptions(selectedLevel, { includeInherit = false } = {}) {
    const options = includeInherit ? AGENT_LOG_LEVEL_OPTIONS : LOG_LEVEL_OPTIONS;
    const selected = normalizeLogLevel(selectedLevel, {
        allowInherit: includeInherit,
        fallback: includeInherit ? 'inherit' : DEFAULT_CONFIG.consoleLogLevel,
    });
    const labels = {
        inherit: 'Inherit global level',
        off: 'Off',
        error: 'Error',
        warn: 'Warn',
        info: 'Info',
        debug: 'Debug',
        trace: 'Trace',
    };
    return options
        .map(level => `<option value="${level}" ${level === selected ? 'selected' : ''}>${labels[level]}</option>`)
        .join('');
}

function renderLogsWorkspace() {
    const logs = Array.isArray(sceneDirectorState.operationLogs) ? sceneDirectorState.operationLogs : [];
    const runningCount = logs.filter(log => log.status === 'running').length;
    const errorCount = logs.filter(log => log.status === 'error').length;

    return `
        <div class="sd-main sd-main--logs">
            ${renderPersistentIssueBanner()}
            <section class="sd-hero sd-hero--logs">
                <div>
                    <div class="sd-eyebrow">Backstage Module</div>
                    <h3>Logs</h3>
                    <p>Runtime history for routing, agents and character generations.</p>
                </div>
                <div class="sd-hero-meta">
                    ${renderStatusBadge(logs[0]?.status ?? 'ready')}
                    <div class="sd-hero-note">${logs.length} retained operations</div>
                </div>
            </section>

            <div class="sd-toolbar">
                <button id="scene-director-clear-logs" class="menu_button">Clear Logs</button>
            </div>

            <div class="sd-summary-grid">
                ${renderStatCard('Operations', String(logs.length), `Retains the latest ${MAX_OPERATION_LOGS}`)}
                ${renderStatCard('Running', String(runningCount), 'Calls currently in progress')}
                ${renderStatCard('Errors', String(errorCount), 'Expand a row for diagnostics')}
                ${renderStatCard('Last Event', logs[0]?.startedAt ? formatPanelTime(new Date(logs[0].startedAt)) : 'never', 'Newest operation first')}
            </div>

            ${renderCard('Console Logging', 'Structured browser-console diagnostics with a stable [Backstage] prefix.', `
                <label for="backstage-console-log-level">Global console level</label>
                <select id="backstage-console-log-level" class="text_pole">
                    ${renderLogLevelOptions(config.consoleLogLevel)}
                </select>
                <label class="sd-checkbox-row" for="backstage-memory-search-logs">
                    <input id="backstage-memory-search-logs" type="checkbox" ${config.memorySearchLogs !== false ? 'checked' : ''}>
                    <span>Show MemoryBox search and verification progress in logs</span>
                </label>
                <div class="sd-footnote">Filter the browser console with <code>[Backstage]</code>. Debug includes request assembly and tool lifecycle summaries; Trace includes high-frequency flow events. Operation History remains available independently.</div>
            `)}

            <section class="sd-card">
                <div class="sd-card-head">
                    <div>
                        <div class="sd-card-title">Operation History</div>
                        <div class="sd-card-subtitle">Expand a row to inspect its request, response, reasoning and error.</div>
                    </div>
                </div>
                <div class="sd-card-body">
                    <div class="sd-log-table">
                        <div class="sd-log-row sd-log-row--head">
                            <span>Time</span>
                            <span>Step</span>
                            <span>Model</span>
                            <span>Tokens</span>
                            <span>Duration</span>
                            <span>Status</span>
                        </div>
                        ${logs.length
                            ? logs.map(renderOperationLogEntry).join('')
                            : '<div class="sd-log-empty">No operations recorded in this session.</div>'}
                    </div>
                </div>
            </section>
        </div>
    `;
}

function renderRouterWorkspacePanel() {
    const routerResponseText = getRouterWorkspaceResponseText();
    return `
        <div class="sd-router-workbench">
            <div class="sd-router-column">
                ${renderCard('Latest Decision', 'Parsed result returned by the router.', renderDecisionSummary(sceneDirectorState.lastDecision))}
                ${renderCard('Context Snapshot', 'What the router used when building the request.', renderContextSummary(sceneDirectorState.lastContext))}
                ${renderCard('Trigger Settle', 'After a profile switch, Backstage waits for a quiet event window before /trigger.', renderTriggerSettleSummary(sceneDirectorState.triggerSettle))}
            </div>
            <div class="sd-router-column sd-router-column--text">
                ${renderDisclosure('Router OOC', 'Chamada direta e descartavel para conversar com o router fora do runtime normal.', `
                    <textarea id="router-ooc-request" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(sceneDirectorState.routerOocDraft || ROUTER_OOC_DEFAULT_DRAFT)}</textarea>
                    <div class="sd-inline-actions">
                        <button id="router-send-ooc" class="menu_button primary">Send OOC</button>
                        <button id="router-clear-ooc" class="menu_button">Clear Draft</button>
                    </div>
                    <div class="sd-footnote">Usa o perfil do router, envia o contexto atual e mostra a resposta na UI sem disparar personagens.</div>
                `, { open: true })}
                ${renderDisclosure('Router Response', 'Resposta direta da ultima chamada OOC ao router ou da ultima execucao capturada.', `
                    ${renderTokenCountedConsole(routerResponseText, 'No router response yet.', 'sd-console--tall')}
                `)}
            </div>
        </div>
    `;
}

function renderRouterConfigPanel() {
    return `
        <div class="sd-grid">
            ${renderCard('Router Settings', 'Connection and input budget for speaker selection.', `
                <label>Connection profile</label>
                <select id="router-profile-dropdown" class="text_pole"></select>

                <label>Input token budget (0 = connection preset)</label>
                <input type="number" id="router-input-token-budget" class="text_pole" min="0" max="2000000" step="1000" value="${config.routerInputTokenBudget}">
                <div class="sd-footnote">The newest RP messages fill the available input after the router prompt and explicitly referenced agent outputs.</div>
            `)}
        </div>
        ${renderCard('Router Prompt Template', 'Editable system prompt used by the turn router.', `
            <textarea id="router-prompt" class="text_pole sd-editor-textarea" spellcheck="false">${escapeHtml(config.routerPrompt)}</textarea>
            ${renderEditorMeta('Autosaves when focus leaves the field.', 'router-prompt-token-counter')}
            <div class="sd-template-tags" aria-label="Router template tags">
                ${[
                    '{{recentChat}}',
                    '{{players}}',
                    '{{lastSpeaker}}',
                    '{{user}}',
                    '{{agent:id}}',
                ].map(tag => `<code>${escapeHtml(tag)}</code>`).join('')}
            </div>
            <div class="sd-footnote">Context is fetched and sent only when its tag is present in this template.</div>
        `)}
    `;
}

function renderRouterWorkspace() {
    const castCount = Array.isArray(config.characters) ? config.characters.length : 0;
    const routerView = sceneDirectorState.routerView === 'config' ? 'config' : 'workspace';

    return `
        <div class="sd-main sd-main--router">
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
                ${(isProcessing || cancellableOperations.isActive('router')) ? '<button id="scene-director-stop" class="menu_button">Stop</button>' : ''}
                <button id="scene-director-test-director" class="menu_button">Test Router</button>
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
                ${renderStatCard('Tracked Cast', String(castCount), 'Managed from Agent connection groups')}
                ${renderStatCard('Captured Prompt', sceneDirectorState.lastPromptMessages?.length ? 'Yes' : 'No', 'Latest router request payload')}
            </div>

            <div class="sd-router-content${routerView === 'config' ? ' sd-router-content--config' : ''}">
                ${routerView === 'config'
                    ? renderRouterConfigPanel()
                    : renderRouterWorkspacePanel()}
            </div>
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

async function initAgentScriptEditor(agent) {
    try {
        await mountAgentScriptEditor('agent-action-editor', agent.actionScript, {
            onBlur: value => {
                agent.actionScript = String(value ?? '');
                saveConfig();
            },
        });
    } catch (error) {
        const message = error?.message ?? String(error);
        backstageLogger.error(getAgentLogScope(agent), 'Could not initialize the JavaScript editor', error);
        $('#agent-action-editor').html(`<div class="sd-console sd-console--error">${escapeHtml(message)}</div>`);
    }
}

function positionSceneDirectorPanel() {
    const panel = document.getElementById('scene-director-panel');
    if (!panel) return;

    const margin = window.matchMedia('(max-width: 720px)').matches ? 10 : 12;
    panel.style.top = `${margin}px`;
}

function refreshSceneDirectorPanel() {
    const panel = $('#scene-director-panel');
    const toggleStatusText = getTogglePipelineStatus();
    $('#scene-director-toggle-status')
        .text(toggleStatusText)
        .attr('title', sceneDirectorState.persistentIssue ? `${sceneDirectorState.persistentIssueSource || 'Issue'}: ${sceneDirectorState.persistentIssue}` : toggleStatusText);
    if (!panel.length) return;

    characterSummaryPanel.dispose();

    flushTextEditors();
    destroyTextEditors();

    panel.toggleClass('sd-hidden', !sceneDirectorState.panelOpen);
    positionSceneDirectorPanel();

    const liveScript = getAgentScriptEditorValue();
    const selectedBeforeRender = getSelectedAgent();
    if (liveScript != null && selectedBeforeRender) {
        selectedBeforeRender.actionScript = liveScript;
    }
    destroyAgentScriptEditor();

    const body = $('#scene-director-panel-body');
    const workspace = sceneDirectorState.activeTab === 'agents'
        ? renderAgentsWorkspace()
        : sceneDirectorState.activeTab === 'memory'
            ? renderMemoryWorkspace()
            : sceneDirectorState.activeTab === 'evaluation'
                ? renderEvaluationWorkspace()
                : sceneDirectorState.activeTab === 'logs'
                    ? renderLogsWorkspace()
                    : renderRouterWorkspace();
    body.html(`
        <div class="sd-shell${sceneDirectorState.activeTab === 'agents' ? ' sd-shell--characters' : ''}">
            ${renderWorkspaceNav()}
            ${workspace}
        </div>
    `);

    const latestLogStatus = sceneDirectorState.operationLogs?.[0]?.status ?? 'ready';
    const selectedAgent = getSelectedAgent();
    const selectedAgentStatus = selectedAgent ? getAgentRuntimeState(selectedAgent.id).lastStatus : 'idle';
    $('#scene-director-header-status').html(
        sceneDirectorState.activeTab === 'agents'
            ? renderStatusBadge(selectedAgentStatus)
            : sceneDirectorState.activeTab === 'memory'
                ? renderStatusBadge(sceneDirectorState.memoryWorkspace.status)
                : sceneDirectorState.activeTab === 'evaluation'
                    ? renderStatusBadge(sceneDirectorState.evaluationWorkspace.status)
            : sceneDirectorState.activeTab === 'logs'
                ? renderStatusBadge(latestLogStatus)
                : renderStatusBadge(sceneDirectorState.routerStatus)
    );

    if (sceneDirectorState.activeTab === 'router') {
        if (sceneDirectorState.routerView === 'config') {
            initRouterProfileDropdown();
        }
    } else if (sceneDirectorState.activeTab === 'agents' && sceneDirectorState.agentView === 'config') {
        initAgentProfileDropdown();
        initAgentWorldInfoSelect();
    } else if (sceneDirectorState.activeTab === 'agents' && sceneDirectorState.agentView === 'script' && selectedAgent) {
        initAgentScriptEditor(selectedAgent);
    }

    if (sceneDirectorState.activeTab === 'agents') {
        initCharProfileDropdowns();
    } else if (sceneDirectorState.activeTab === 'memory') {
        initMemorySourceSelects();
    }

    refreshVisiblePromptTokenCounters();
    characterSummaryPanel.updateControls(document.querySelector('.sd-memory-summary'));
    characterSummaryPanel.initTabs();
    if (sceneDirectorState.activeTab === 'agents') initAgentContentTabs();
    else mountVisibleTextEditors();
    refreshAgentRecentChatTokenCount();
    updateRuntimeTimingUi();
}

let recentChatTokenCountVersion = 0;
let recentChatTokenCountDebounce = null;

async function refreshAgentRecentChatTokenCount() {
    const counter = document.getElementById('agent-recent-chat-tokens');
    const input = document.getElementById('agent-context-messages');
    if (!sceneDirectorState.panelOpen || !counter || !input || !input.getClientRects().length) return;

    const version = ++recentChatTokenCountVersion;
    const ctx = SillyTavern.getContext();
    const limit = Math.min(5000, Math.max(1, parseInt(input.value) || DEFAULT_AGENT_CONTEXT_MESSAGES));
    const includeHidden = document.getElementById('agent-include-hidden')?.checked ?? getSelectedAgent()?.includeHiddenMessages;
    const agent = getSelectedAgent();
    const offset = normalizeContextMessageOffset(document.getElementById('agent-context-message-offset')?.value ?? agent?.contextMessageOffset);
    const formatSettings = { ...agent,
        applyPromptRegex: document.getElementById('agent-apply-prompt-regex')?.checked ?? agent?.applyPromptRegex };
    let entries;
    try {
        entries = agent?.internalType === SUMMARY_CREATION_TYPE
            ? formatAgentRpContext(formatSettings, summaryCreation.prepare({ ...agent, contextMessages: limit,
                contextMessageOffset: offset, includeHiddenMessages: includeHidden }, ctx).entries.map(entry => entry.message), ctx, true)
            : formatAgentRpContext(formatSettings, getRpContextMessages(ctx.chat, includeHidden, offset).slice(-limit), ctx);
    } catch (error) {
        counter.textContent = error.message;
        return;
    }
    const text = entries.join('\n');
    counter.textContent = `Current chat: ${entries.length} messages · calculating...`;
    try {
        const tokens = text ? await ctx.getTokenCountAsync(text) : 0;
        if (version !== recentChatTokenCountVersion || !counter.isConnected) return;
        counter.textContent = `Current chat: ${entries.length} messages · ${Number(tokens) || 0} tokens`;
    } catch {
        if (version !== recentChatTokenCountVersion || !counter.isConnected) return;
        counter.textContent = `Current chat: ${entries.length} messages · token count unavailable`;
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
        updateRuntimeTimingUi();
        characterSummaryPanel.refreshRatings();
    }, 400);

    if (window.__backstageRecentChatTokenInterval) window.clearInterval(window.__backstageRecentChatTokenInterval);
    window.__backstageRecentChatTokenInterval = window.setInterval(refreshAgentRecentChatTokenCount, 10000);
}

function formatRouterPromptForCopy(request) {
    if (!request?.messages?.length) return '';

    return request.messages
        .map(message => String(message.content ?? ''))
        .join('\n\n');
}

async function copyDirectorPromptToClipboard() {
    const promptText = formatRouterPromptForCopy(lastRouterRequest);

    if (!promptText) {
        toastr.warning('No router request captured yet.', EXTENSION_LABEL);
        return;
    }

    try {
        await navigator.clipboard.writeText(promptText);
        toastr.success('Router request copied.', EXTENSION_LABEL);
    } catch (error) {
        backstageLogger.error('UI', 'Failed to copy Router prompt', error);
        toastr.error('Could not copy the router request. See console.', EXTENSION_LABEL);
    }
}

function getSelectedAgentWorldInfoBooks() {
    return $('#agent-world-info-books input[type="checkbox"]:checked')
        .map((_, input) => String($(input).val() || '').trim())
        .get()
        .filter(Boolean);
}

function updateAgentWorldInfoCount() {
    const count = getSelectedAgentWorldInfoBooks().length;
    $('#agent-world-info-count').text(`${count} selected`);
}

function getAgentInjectionTargetsFromPanel() {
    return $('#agent-injection-targets [data-agent-injection-target]')
        .map((_, row) => {
            const element = $(row);
            const characterSelect = element.find('[data-agent-injection-character]');
            const selectedOption = characterSelect.find('option:selected');
            return {
                characterAvatar: String(characterSelect.val() ?? ''),
                characterName: String(characterSelect.attr('data-character-name') ?? selectedOption.attr('data-character-name') ?? selectedOption.text() ?? '')
                    .replace(/\s*\(unavailable\)\s*$/i, '')
                    .trim(),
                mode: element.find('[data-agent-injection-mode]').val() === 'full' ? 'full' : 'tag',
                tag: normalizeOutputTagName(element.find('[data-agent-injection-tag]').val()),
                optional: element.find('[data-agent-injection-optional]').is(':checked'),
            };
        })
        .get();
}

function preserveVisiblePanelDrafts() {
    flushTextEditors();
    const routerPrompt = $('#router-prompt');
    if (routerPrompt.length) {
        config.routerPrompt = routerPrompt.val();
    }

    const routerOoc = $('#router-ooc-request');
    if (routerOoc.length) {
        sceneDirectorState.routerOocDraft = String(routerOoc.val() ?? '');
    }

    const selectedAgent = getSelectedAgent();
    const agentOoc = $('#agent-ooc-request');
    if (selectedAgent && agentOoc.length) {
        updateAgentOocState(selectedAgent.id, { draft: String(agentOoc.val() ?? '') });
    }

    persistAgentPanelFields();
    captureMemoryWorkspaceFields();
    if ($('#evaluation-query').length) {
        sceneDirectorState.evaluationWorkspace.query = String($('#evaluation-query').val() ?? '');
        sceneDirectorState.evaluationWorkspace.groupIds = String($('#evaluation-group-ids').val() ?? '');
        sceneDirectorState.evaluationWorkspace.count = Math.min(50, Math.max(1, Number($('#evaluation-count').val()) || 8));
    }
    destroyAgentScriptEditor();
    clearRouterPromptSaveTimer();
    saveConfig();
}

function clearRouterPromptSaveTimer() {
    if (!routerPromptSaveTimer) return;
    window.clearTimeout(routerPromptSaveTimer);
    routerPromptSaveTimer = null;
}

function scheduleRouterPromptSave() {
    clearRouterPromptSaveTimer();
    routerPromptSaveTimer = window.setTimeout(() => {
        routerPromptSaveTimer = null;
        saveConfig();
    }, 500);
}

function schedulePromptTokenCounterUpdate(textareaId, counterId) {
    scheduleTokenCounterUpdate(
        textareaId,
        counterId,
        text => SillyTavern.getContext().getTokenCountAsync(text),
    );
}

function refreshVisiblePromptTokenCounters() {
    schedulePromptTokenCounterUpdate('router-prompt', 'router-prompt-token-counter');
    schedulePromptTokenCounterUpdate('agent-prompt', 'agent-prompt-token-counter');
    schedulePromptTokenCounterUpdate('agent-output', 'agent-output-token-counter');
    refreshReadOnlyTokenCounters(
        document.getElementById('scene-director-panel-body'),
        text => SillyTavern.getContext().getTokenCountAsync(text),
    );
}

function updateRuntimeTimingUi() {
    const now = Date.now();
    document.querySelectorAll('#scene-director-panel [data-log-started-at]').forEach(element => {
        const startedAt = Number(element.getAttribute('data-log-started-at'));
        if (Number.isFinite(startedAt) && startedAt > 0) {
            element.textContent = formatDurationMs(now - startedAt);
        }
    });
}

function persistDirectorPanelFields() {
    const routerInputTokenBudget = $('#router-input-token-budget');
    const routerPrompt = $('#router-prompt');

    if ($('#router-profile-dropdown').length) {
        config.routerProfileId = $('#router-profile-dropdown').val() || config.routerProfileId;
    }
    if (routerInputTokenBudget.length) {
        config.routerInputTokenBudget = Math.max(0, parseInt(routerInputTokenBudget.val()) || 0);
    }
    if (routerPrompt.length) {
        config.routerPrompt = routerPrompt.val();
    }
    if ($('#router-ooc-request').length) {
        sceneDirectorState.routerOocDraft = String($('#router-ooc-request').val() ?? '');
    }

    clearRouterPromptSaveTimer();
    saveConfig();
}

function persistAgentPanelFields() {
    const agent = getSelectedAgent();
    if (!agent) return;

    if ($('#agent-enabled').length) agent.enabled = $('#agent-enabled').is(':checked');
    if ($('#agent-name').length) agent.name = String($('#agent-name').val() ?? '').trim() || agent.name;
    if ($('#agent-connection-mode').length) {
        agent.connectionMode = $('#agent-connection-mode').val() === AGENT_CONNECTION_MODES.PROFILE
            ? AGENT_CONNECTION_MODES.PROFILE
            : AGENT_CONNECTION_MODES.PARENT;
    }
    if ($('#agent-profile-dropdown').length) agent.profileId = $('#agent-profile-dropdown').val() || agent.profileId;
    if ($('#agent-reference-character').length) {
        const referenceAvatar = String($('#agent-reference-character').val() ?? '');
        const referenceCharacter = (SillyTavern.getContext().characters ?? [])
            .find(character => String(character?.avatar ?? '') === referenceAvatar);
        agent.referenceCharacterAvatar = referenceAvatar;
        agent.referenceCharacterName = String(referenceCharacter?.name ?? '').trim();
    }
    if ($('#agent-world-info-books').length) {
        agent.worldInfoBooks = getSelectedAgentWorldInfoBooks();
    }
    if ($('#agent-graphiti-ooc-enabled').length) {
        agent.graphitiOocEnabled = $('#agent-graphiti-ooc-enabled').is(':checked');
    }
    if ($('#agent-graphiti-automatic-enabled').length) {
        agent.graphitiAutomaticEnabled = $('#agent-graphiti-automatic-enabled').is(':checked');
    }
    if ($('#agent-graphiti-read-groups').length) {
        agent.graphitiReadGroupIds = normalizeGraphitiGroupIds($('#agent-graphiti-read-groups').val());
    }
    if ($('#agent-graphiti-write-group').length) {
        const groupId = String($('#agent-graphiti-write-group').val() ?? '').trim();
        agent.graphitiWriteGroupId = isValidGraphitiGroupId(groupId) ? groupId : '';
    }
    for (const mode of ['ooc', 'automatic']) {
        const permissions = $('[data-agent-graphiti-permission][data-agent-graphiti-mode="' + mode + '"]')
            .filter(':checked')
            .map((_, element) => String($(element).attr('data-agent-graphiti-permission') ?? ''))
            .get();
        if ($(`[data-agent-graphiti-mode="${mode}"]`).length) {
            agent[mode === 'ooc' ? 'graphitiOocPermissions' : 'graphitiAutomaticPermissions'] = normalizeGraphitiPermissions(permissions);
        }
    }
    if ($('#agent-schedule-type').length) {
        const scheduleType = String($('#agent-schedule-type').val() ?? 'manual');
        agent.scheduleType = AGENT_SCHEDULE_TYPES.has(scheduleType) ? scheduleType : 'manual';
    }
    if ($('#agent-interval').length) agent.interval = Math.min(10000, Math.max(1, parseInt($('#agent-interval').val()) || 1));
    if ($('#agent-character-name').length) agent.characterName = String($('#agent-character-name').val() ?? '').trim();
    if ($('#agent-context-messages').length) {
        agent.contextMessages = Math.min(5000, Math.max(1, parseInt($('#agent-context-messages').val()) || DEFAULT_AGENT_CONTEXT_MESSAGES));
    }
    if ($('#agent-include-hidden').length) agent.includeHiddenMessages = $('#agent-include-hidden').is(':checked');
    if ($('#agent-context-message-offset').length) {
        agent.contextMessageOffset = normalizeContextMessageOffset($('#agent-context-message-offset').val());
    }
    if ($('#agent-apply-prompt-regex').length) agent.applyPromptRegex = $('#agent-apply-prompt-regex').is(':checked');
    if ($('#agent-max-tool-rounds').length) {
        agent.maxToolRounds = Math.min(MAX_AGENT_TOOL_ROUNDS, Math.max(1, parseInt($('#agent-max-tool-rounds').val()) || DEFAULT_AGENT_MAX_TOOL_ROUNDS));
    }
    if ($('#agent-log-level').length) {
        agent.logLevel = normalizeLogLevel($('#agent-log-level').val(), { allowInherit: true, fallback: 'inherit' });
    }
    if ($('#agent-validate-output-format').length) {
        agent.validateOutputFormat = $('#agent-validate-output-format').is(':checked');
    }
    if ($('#agent-action-enabled').length) {
        agent.actionEnabled = $('#agent-action-enabled').is(':checked');
    }
    if ($('#agent-action-auto-run').length) {
        agent.actionAutoRun = $('#agent-action-auto-run').is(':checked');
    }
    if ($('#agent-action-test-payload').length) {
        agent.actionTestPayload = String($('#agent-action-test-payload').val() ?? '');
    }
    const actionScript = getAgentScriptEditorValue();
    if (actionScript != null) {
        agent.actionScript = actionScript;
    }
    if ($('#agent-character-injection-enabled').length) {
        agent.characterInjectionEnabled = $('#agent-character-injection-enabled').is(':checked');
    }
    if ($('input[name="agent-injection-position"]:checked').length) {
        agent.characterInjectionPosition = String($('input[name="agent-injection-position"]:checked').val() ?? AGENT_INJECTION_POSITIONS.IN_CHAT);
    }
    if ($('#agent-injection-depth').length) {
        agent.characterInjectionDepth = Math.min(9999, Math.max(0, parseInt($('#agent-injection-depth').val()) || 0));
    }
    if ($('#agent-injection-role').length) {
        agent.characterInjectionRole = Math.min(2, Math.max(0, parseInt($('#agent-injection-role').val()) || 0));
    }
    const normalizedPlacement = normalizeAgentInjectionPlacement(agent);
    agent.characterInjectionPosition = normalizedPlacement.position;
    agent.characterInjectionDepth = normalizedPlacement.depth;
    agent.characterInjectionRole = normalizedPlacement.role;
    if ($('#agent-injection-targets').length) {
        agent.characterInjectionTargets = normalizeCharacterInjectionTargets(getAgentInjectionTargetsFromPanel());
    }
    if ($('#agent-prompt').length) agent.prompt = String($('#agent-prompt').val() ?? '');
    if ($('#agent-output').length) {
        const nextOutput = String($('#agent-output').val() ?? '');
        if (nextOutput !== getAgentRuntimeState(agent.id).output) {
            const validation = validateAgentOutput(agent, nextOutput);
            if (validation.valid) {
                saveAgentRuntimeState(agent.id, {
                    output: nextOutput,
                    updatedAt: new Date().toISOString(),
                    lastStatus: 'success',
                    lastError: '',
                });
            } else {
                saveAgentRuntimeState(agent.id, {
                    lastStatus: 'error',
                    lastError: `Edited output was not saved: ${validation.error}`,
                });
                toastr.error(validation.error, EXTENSION_LABEL);
            }
        }
    }
    saveConfig();
}

function addAgentInjectionTarget() {
    persistAgentPanelFields();
    const agent = getSelectedAgent();
    if (!agent) return;

    const usedAvatars = new Set(normalizeCharacterInjectionTargets(agent.characterInjectionTargets)
        .map(target => target.characterAvatar)
        .filter(Boolean));
    const character = (SillyTavern.getContext().characters ?? [])
        .find(item => item?.avatar && item?.name && !usedAvatars.has(String(item.avatar)));
    if (!character) {
        toastr.warning('No additional group character is available.', EXTENSION_LABEL);
        return;
    }

    agent.characterInjectionTargets.push({
        characterAvatar: String(character.avatar),
        characterName: String(character.name),
        mode: 'tag',
        tag: String(character.name).trim().split(/\s+/)[0],
    });
    saveConfig();
    refreshSceneDirectorPanel();
}

function createAgentFromPanel() {
    const name = String($('#agent-new-name').val() ?? '').trim();
    if (!name) {
        toastr.warning('Enter an agent name first.', EXTENSION_LABEL);
        return null;
    }

    const activeOwner = getActiveAgentOwner();
    const id = createAgentIdForOwner(name, activeOwner);
    const agent = normalizeAgentDefinition({
        id,
        name,
        enabled: true,
        scheduleType: 'manual',
        interval: 5,
        contextMessages: DEFAULT_AGENT_CONTEXT_MESSAGES,
        prompt: `You are ${name}, a focused support agent for an ongoing group roleplay.\n\nTask:\n- Define one narrow responsibility here.\n- Maintain only information relevant to that responsibility.\n- Update the prior state instead of discarding valid facts.\n- Do not narrate the roleplay.\n\nPrevious output:\n{{previousOutput}}\n\nRecent RP context:\n{{recentChat}}`,
    }, config.agents.length);
    applyAgentOwnerValue(agent, activeOwner.key);
    agent.displayOrder = Math.max(-1, ...getAgentsForOwner(activeOwner.key).map(item => item.displayOrder || 0)) + 1;
    config.agents.push(agent);
    sceneDirectorState.activeAgentId = agent.id;
    sceneDirectorState.agentView = 'config';
    saveConfig();
    refreshSceneDirectorPanel();
    return agent;
}

function deleteSelectedAgent() {
    const agent = getSelectedAgent();
    if (!agent || !window.confirm(`Delete agent "${agent.name}"?`)) return false;

    config.agents = config.agents.filter(item => item.id !== agent.id);
    const metadata = getAgentMetadata();
    delete metadata[agent.id];
    SillyTavern.getContext().saveMetadata?.();
    sceneDirectorState.activeAgentId = getAgentsForOwner()[0]?.id ?? '';
    saveConfig();
    refreshSceneDirectorPanel();
    return true;
}

function attachFloatingPanelEvents() {
    $(window)
        .off('scroll.backstagePanelPosition resize.backstagePanelPosition')
        .on('scroll.backstagePanelPosition resize.backstagePanelPosition', positionSceneDirectorPanel);
    $('#scene-director-toggle').on('click', () => {
        if (sceneDirectorState.panelOpen) preserveVisiblePanelDrafts();
        updateSceneDirectorState({ panelOpen: !sceneDirectorState.panelOpen });
    });
    $('#scene-director-close').on('click', () => {
        preserveVisiblePanelDrafts();
        updateSceneDirectorState({ panelOpen: false });
    });
    $(document).off('mousedown.backstagePanelDismiss').on('mousedown.backstagePanelDismiss', (event) => {
        if (!sceneDirectorState.panelOpen) {
            return;
        }

        const root = document.getElementById('scene-director-floating-root');
        if (!root) {
            return;
        }

        if (root.contains(event.target)) {
            return;
        }

        preserveVisiblePanelDrafts();
        persistDirectorPanelFields();
        updateSceneDirectorState({ panelOpen: false });
    });
    $('#scene-director-panel-body').on('click', '[data-stage]', function () {
        preserveVisiblePanelDrafts();
        updateSceneDirectorState({ activeTab: $(this).data('stage') || 'router' });
        const panelBody = document.getElementById('scene-director-panel-body');
        if (panelBody) panelBody.scrollTop = 0;
    });
    $('#scene-director-panel-body').on('click', '.sd-log-entry > summary', function (event) {
        const entry = this.parentElement;
        if (!entry || entry.dataset.empty === 'true') {
            event.preventDefault();
            return;
        }

        const body = entry.querySelector('[data-operation-log-body]');
        if (!body || body.dataset.loaded === 'true') return;

        const logId = String(entry.dataset.operationLogId ?? '');
        const log = (sceneDirectorState.operationLogs ?? []).find(item => item.id === logId);
        if (!log) return;

        body.innerHTML = renderOperationLogBody(log);
        body.dataset.loaded = 'true';
        window.setTimeout(refreshVisiblePromptTokenCounters, 0);
    });
    $('#scene-director-panel-body').on('click', '.sd-disclosure-summary', () => {
        window.setTimeout(refreshVisiblePromptTokenCounters, 0);
    });
    document.getElementById('scene-director-panel-body').addEventListener('error', event => {
        if (event.target.matches('img[data-character-portrait]')) event.target.remove();
    }, true);
    $(document).off('mousedown.backstageCharacterPicker keydown.backstageCharacterPicker')
        .on('mousedown.backstageCharacterPicker', event => {
            const picker = document.querySelector('#scene-director-panel .sd-character-picker[open]');
            if (picker && !picker.contains(event.target)) {
                picker.open = false;
                picker.querySelector('summary').setAttribute('aria-expanded', 'false');
            }
        })
        .on('keydown.backstageCharacterPicker', event => {
            const picker = document.querySelector('#scene-director-panel .sd-character-picker[open]');
            if (!picker || event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            picker.open = false;
            picker.querySelector('summary').setAttribute('aria-expanded', 'false');
            picker.querySelector('summary').focus();
        });
    $('#scene-director-panel-body').on('click', '.sd-character-picker > summary', function () {
        const picker = this.parentElement;
        window.setTimeout(() => {
            this.setAttribute('aria-expanded', String(picker.open));
            if (picker.open) picker.querySelector('[data-agent-owner-key][aria-pressed="true"]')?.focus();
        }, 0);
    });
    $('#scene-director-panel-body').on('keydown', '[data-agent-owner-key]', function (event) {
        const grid = this.closest('.sd-character-picker-grid');
        const choices = [...grid.querySelectorAll('[data-agent-owner-key]')];
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        let index = choices.indexOf(this);
        if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = choices.length - 1;
        else if (offset != null) index = Math.min(choices.length - 1, Math.max(0, index + offset));
        else return;
        event.preventDefault();
        choices[index].focus();
    });
    $('#scene-director-panel-body').on('click', '[data-router-view]', function () {
        preserveVisiblePanelDrafts();
        updateRouterState({ routerView: $(this).data('router-view') || 'workspace' });
    });
    $('#scene-director-panel-body').on('click', '[data-agent-view]', function () {
        switchAgentView($(this).data('agent-view') || 'workspace');
    });
    $('#scene-director-panel-body').on('click', '[data-character-view]', function () {
        preserveVisiblePanelDrafts();
        sceneDirectorState.characterView = $(this).attr('data-character-view') === 'summary' ? 'summary' : 'agents';
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '[data-summary-field]', function () {
        characterSummaryPanel.saveField(this);
    });
    $('#scene-director-panel-body').on('click', '[data-summary-refresh]', () => {
        characterSummaryPanel.load();
    });
    $('#scene-director-panel-body').on('click', '[data-summary-usage-run]', () => {
        characterSummaryPanel.runUsageTest();
    });
    $('#scene-director-panel-body').on('input', '[data-summary-usage-text]', function () {
        characterSummaryPanel.updateUsageDraft(this.value);
    });
    $('#scene-director-panel-body').on('click', '[data-summary-usage-stop]', () => {
        characterSummaryPanel.stopUsageTest();
    });
    $('#scene-director-panel-body').on('click', '[data-summary-reinforcement-stop]', () => {
        characterSummaryPanel.stopReinforcement();
    });
    $('#scene-director-panel-body').on('click', '[data-character-connections]', function () {
        sceneDirectorState.characterConnectionsOpen = !sceneDirectorState.characterConnectionsOpen;
        $(this).attr('aria-expanded', String(sceneDirectorState.characterConnectionsOpen));
        $('#character-connections').toggleClass('sd-hidden', !sceneDirectorState.characterConnectionsOpen);
        window.dispatchEvent(new Event('resize'));
    });
    $('#scene-director-panel-body').on('keydown', '[data-character-view]', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const target = $(this).attr('data-character-view') === 'summary' ? 'agents' : 'summary';
        $(`[data-character-view="${target}"]`).trigger('click');
        $(`[data-character-view="${target}"]`).trigger('focus');
    });
    $('#scene-director-panel-body').on('click', '[data-agent-id]', function () {
        preserveVisiblePanelDrafts();
        updateSceneDirectorState({ activeAgentId: String($(this).data('agent-id') ?? '') });
    });
    $('#scene-director-panel-body').on('click', '[data-agent-move]', function () {
        preserveVisiblePanelDrafts();
        const agents = getAgentsForOwner();
        const agent = getSelectedAgent();
        const offset = Number($(this).attr('data-agent-move'));
        const target = agents[agents.indexOf(agent) + offset];
        if (!agent || !target) return;
        reorderVisibleAgent(agent.id, target.id, offset > 0);
        refreshSceneDirectorPanel();
    });
    let draggedAgentId = '';
    $('#scene-director-panel-body').on('dragstart', '[data-agent-id]', function (event) {
        draggedAgentId = String($(this).attr('data-agent-id'));
        event.originalEvent.dataTransfer.setData('text/plain', draggedAgentId);
        event.originalEvent.dataTransfer.effectAllowed = 'move';
        $(this).addClass('sd-agent-dragging');
    });
    $('#scene-director-panel-body').on('dragover', '[data-agent-id]', function (event) {
        if (!draggedAgentId || draggedAgentId === $(this).attr('data-agent-id')) return;
        event.preventDefault();
        const bounds = this.getBoundingClientRect();
        const after = event.originalEvent.clientY > bounds.top + bounds.height / 2;
        $('#scene-director-panel .sd-agent-drop-before, #scene-director-panel .sd-agent-drop-after').removeClass('sd-agent-drop-before sd-agent-drop-after');
        $(this).addClass(after ? 'sd-agent-drop-after' : 'sd-agent-drop-before');
    });
    $('#scene-director-panel-body').on('drop', '[data-agent-id]', function (event) {
        if (!draggedAgentId) return;
        event.preventDefault();
        preserveVisiblePanelDrafts();
        reorderVisibleAgent(draggedAgentId, String($(this).attr('data-agent-id')), $(this).hasClass('sd-agent-drop-after'));
        draggedAgentId = '';
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('dragend', '[data-agent-id]', () => {
        draggedAgentId = '';
        $('#scene-director-panel .sd-agent-dragging, #scene-director-panel .sd-agent-drop-before, #scene-director-panel .sd-agent-drop-after')
            .removeClass('sd-agent-dragging sd-agent-drop-before sd-agent-drop-after');
    });
    $('#scene-director-panel-body').on('keydown', '[data-agent-id]', function (event) {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const agents = getAgentsForOwner();
        const index = agents.findIndex(agent => agent.id === $(this).attr('data-agent-id'));
        const target = agents[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (!target || index < 0) return;
        event.preventDefault();
        preserveVisiblePanelDrafts();
        const id = agents[index].id;
        reorderVisibleAgent(id, target.id, event.key === 'ArrowDown');
        refreshSceneDirectorPanel();
        $('#scene-director-panel [data-agent-id]').filter((_, item) => item.dataset.agentId === id).trigger('focus');
    });
    $('#scene-director-panel-body').on('click', '[data-agent-owner-key]', function () {
        preserveVisiblePanelDrafts();
        const ownerKey = String($(this).data('agent-owner-key') ?? AGENT_OWNER_TYPES.GLOBAL);
        sceneDirectorState.activeAgentOwnerKey = ownerKey;
        sceneDirectorState.activeAgentId = getAgentsForOwner(ownerKey)[0]?.id ?? '';
        refreshSceneDirectorPanel();
        document.querySelector('#scene-director-panel .sd-character-picker > summary')?.focus();
    });
    $('#scene-director-panel-body').on('click', '#agent-create', () => createAgentFromPanel());
    $('#scene-director-panel-body').on('change', '#memory-source-characters input, #memory-source-lorebooks input', captureMemoryWorkspaceFields);
    $('#scene-director-panel-body').on('focusout', '#memory-group-id, #memory-source-description', captureMemoryWorkspaceFields);
    $('#scene-director-panel-body').on('click', '#memory-check-status', async () => {
        try {
            const result = await getLongTermMemoryStatus();
            sceneDirectorState.memoryWorkspace.result = JSON.stringify(result, null, 2);
            sceneDirectorState.memoryWorkspace.status = 'success';
            sceneDirectorState.memoryWorkspace.error = '';
            refreshSceneDirectorPanel();
        } catch (error) {
            sceneDirectorState.memoryWorkspace.status = 'error';
            sceneDirectorState.memoryWorkspace.error = error?.message ?? String(error);
            refreshSceneDirectorPanel();
        }
    });
    $('#scene-director-panel-body').on('click', '#memory-ingest', async () => {
        try {
            await runMemoryIngestion();
        } catch (error) {
            toastr.error(error?.message ?? String(error), EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#memory-stop', () => memoryIngestionController?.abort());
    $('#scene-director-panel-body').on('click', '#evaluation-run', async () => {
        try {
            await runMemoryEvaluation();
        } catch (error) {
            toastr.error(error?.message ?? String(error), EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#agent-refresh-group', () => {
        loadGroupMembers();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '[data-character-agent-mode]', function () {
        const index = Number($(this).attr('data-character-agent-mode'));
        if (!Number.isInteger(index) || !config.characters[index]) return;
        config.characters[index].agentProfileMode = $(this).val() === CHARACTER_AGENT_CONNECTION_MODES.PROFILE
            ? CHARACTER_AGENT_CONNECTION_MODES.PROFILE
            : CHARACTER_AGENT_CONNECTION_MODES.GENERATION;
        saveConfig();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('keydown', '#agent-new-name', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            createAgentFromPanel();
        }
    });
    $('#scene-director-panel-body').on('click', '#agent-run', async () => {
        persistAgentPanelFields();
        const agent = getSelectedAgent();
        if (!agent) return;
        try {
            const result = await executeAgent(agent.id, { type: 'manual', label: 'Manual run from Agents workspace' });
            if (result != null) toastr.success(`${agent.name} updated.`, EXTENSION_LABEL);
        } catch (error) {
            toastr.error(error?.message ?? String(error), EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '[data-summary-creation-retry]', async () => {
        const agent = getSelectedAgent();
        if (!agent || agent.internalType !== SUMMARY_CREATION_TYPE) return;
        try { await executeAgent(agent.id, { type: 'retry-save', label: 'Retry original memory registration' }); }
        catch (error) { toastr.error(error.message, EXTENSION_LABEL); }
    });
    $('#scene-director-panel-body').on('click', '[data-agent-stop]', () => {
        const agent = getSelectedAgent();
        if (!agent) return;
        if (stopAgentExecution(agent.id)) {
            toastr.info(`${agent.name} stopped.`, EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#agent-run-action', async () => {
        persistAgentPanelFields();
        const agent = getSelectedAgent();
        if (!agent) return;
        try {
            await executeConfiguredAgentAction(
                agent,
                getAgentRuntimeState(agent.id).output,
                { type: 'manual', label: 'Manual action from Agents workspace' },
            );
            toastr.success(`${agent.name} action completed.`, EXTENSION_LABEL);
        } catch (error) {
            toastr.error(error?.message ?? String(error), EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#agent-copy-output', async () => {
        const agent = getSelectedAgent();
        if (!agent) return;
        await navigator.clipboard.writeText(getAgentRuntimeState(agent.id).output);
        toastr.success(`${agent.name} output copied.`, EXTENSION_LABEL);
    });
    $('#scene-director-panel-body').on('click', '[data-agent-copy-snapshot]', async function () {
        const agent = getSelectedAgent();
        if (!agent) return;
        const index = Number($(this).attr('data-agent-copy-snapshot'));
        if (!Number.isInteger(index) || index < 0) return;
        await copyAgentOutputSnapshot(agent.id, index);
    });
    $('#scene-director-panel-body').on('click', '#agent-clear-output', () => {
        const agent = getSelectedAgent();
        if (!agent || !window.confirm(`Clear the stored output for "${agent.name}" in this chat?`)) return;
        saveAgentRuntimeState(agent.id, { output: '', updatedAt: '', runId: '', lastStatus: 'idle', lastError: '' });
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#agent-send-ooc', async () => {
        const agent = getSelectedAgent();
        if (!agent) return;
        updateAgentOocState(agent.id, { draft: String($('#agent-ooc-request').val() ?? '') });
        await runAgentOocRequest(agent.id);
    });
    $('#scene-director-panel-body').on('click', '#agent-clear-ooc-draft', () => {
        const agent = getSelectedAgent();
        if (!agent) return;
        updateAgentOocState(agent.id, { draft: AGENT_OOC_DEFAULT_DRAFT });
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#agent-clear-ooc-history', () => {
        const agent = getSelectedAgent();
        if (!agent || !window.confirm(`Clear the OOC conversation for "${agent.name}"?`)) return;
        updateAgentOocState(agent.id, { history: [] });
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#agent-run-ooc-action', async () => {
        persistAgentPanelFields();
        const agent = getSelectedAgent();
        if (!agent) return;
        try {
            await executeConfiguredAgentAction(
                agent,
                getLatestAgentOocAssistantOutput(agent.id),
                { type: 'ooc', label: 'Manual action from latest OOC response' },
            );
            toastr.success(`${agent.name} OOC action completed.`, EXTENSION_LABEL);
        } catch (error) {
            toastr.error(error?.message ?? String(error), EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#agent-action-validate', () => {
        persistAgentPanelFields();
        const agent = getSelectedAgent();
        if (!agent) return;
        const validation = validateAgentActionScript(agent.actionScript);
        if (validation.valid) {
            toastr.success(`${agent.name} JavaScript is valid.`, EXTENSION_LABEL);
        } else {
            toastr.error(validation.error, EXTENSION_LABEL);
        }
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#agent-action-test', async () => {
        persistAgentPanelFields();
        const agent = getSelectedAgent();
        if (!agent) return;
        try {
            await executeConfiguredAgentAction(
                agent,
                agent.actionTestPayload,
                { type: 'test', label: 'Manual action test' },
            );
            toastr.success(`${agent.name} action test completed.`, EXTENSION_LABEL);
        } catch (error) {
            toastr.error(error?.message ?? String(error), EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#agent-delete', () => deleteSelectedAgent());
    $('#scene-director-panel-body').on('focusout', '#agent-id', function () {
        const agent = getSelectedAgent();
        if (!agent) return;
        const result = renameAgentId(agent, $(this).val());
        if (!result.ok) {
            $(this).val(agent.id);
            toastr.error(result.error, EXTENSION_LABEL);
            return;
        }
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('keydown', '#agent-id', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        $(this).trigger('blur');
    });
    $('#scene-director-panel-body').on('focusout', '#agent-name, #agent-interval, #agent-character-name, #agent-context-messages, #agent-context-message-offset, #agent-max-tool-rounds, #agent-prompt, #agent-output, #agent-injection-depth, #agent-action-test-payload, #agent-graphiti-read-groups, #agent-graphiti-write-group, [data-agent-injection-tag]', () => {
        persistAgentPanelFields();
    });
    $('#scene-director-panel-body').on('input', '#agent-context-messages, #agent-context-message-offset', () => {
        if (recentChatTokenCountDebounce) window.clearTimeout(recentChatTokenCountDebounce);
        recentChatTokenCountDebounce = window.setTimeout(refreshAgentRecentChatTokenCount, 400);
    });
    $('#scene-director-panel-body').on('change', '#agent-enabled, #agent-include-hidden, #agent-apply-prompt-regex, #agent-profile-dropdown, #agent-reference-character, #agent-validate-output-format, #agent-graphiti-ooc-enabled, #agent-graphiti-automatic-enabled, #agent-log-level, #agent-action-auto-run, [data-agent-graphiti-permission], [data-agent-injection-character], [data-agent-injection-optional]', () => {
        persistAgentPanelFields();
        refreshAgentRecentChatTokenCount();
    });
    $('#scene-director-panel-body').on('change', '#agent-connection-mode', () => {
        persistAgentPanelFields();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '#agent-action-enabled', () => {
        persistAgentPanelFields();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '#agent-character-injection-enabled, input[name="agent-injection-position"], [data-agent-injection-mode]', () => {
        persistAgentPanelFields();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '#agent-injection-role', () => {
        persistAgentPanelFields();
    });
    $('#scene-director-panel-body').on('click', '#agent-injection-add', () => addAgentInjectionTarget());
    $('#scene-director-panel-body').on('click', '[data-agent-injection-remove]', function () {
        persistAgentPanelFields();
        const agent = getSelectedAgent();
        if (!agent) return;
        const index = Number($(this).attr('data-agent-injection-remove'));
        if (!Number.isInteger(index) || index < 0) return;
        agent.characterInjectionTargets.splice(index, 1);
        saveConfig();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('change', '#agent-world-info-books input[type="checkbox"]', () => {
        updateAgentWorldInfoCount();
        persistAgentPanelFields();
    });
    $('#scene-director-panel-body').on('click', '#agent-world-info-all', () => {
        $('#agent-world-info-books input[type="checkbox"]').prop('checked', true);
        updateAgentWorldInfoCount();
        persistAgentPanelFields();
    });
    $('#scene-director-panel-body').on('click', '#agent-world-info-none', () => {
        $('#agent-world-info-books input[type="checkbox"]').prop('checked', false);
        updateAgentWorldInfoCount();
        persistAgentPanelFields();
    });
    $('#scene-director-panel-body').on('change', '#agent-schedule-type', () => {
        persistAgentPanelFields();
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('input', '#agent-prompt', () => {
        schedulePromptTokenCounterUpdate('agent-prompt', 'agent-prompt-token-counter');
    });
    $('#scene-director-panel-body').on('input', '#agent-output', () => {
        schedulePromptTokenCounterUpdate('agent-output', 'agent-output-token-counter');
    });
    $('#scene-director-panel-body').on('input', '#agent-ooc-request', () => {
        const agent = getSelectedAgent();
        if (agent) updateAgentOocState(agent.id, { draft: String($('#agent-ooc-request').val() ?? '') });
    });
    $('#scene-director-panel-body').on('click', '#scene-director-run', async () => {
        persistDirectorPanelFields();
        await runRouter('floating-panel');
    });
    $('#scene-director-panel-body').on('click', '#scene-director-stop', async () => {
        if (await stopRouterExecution()) {
            toastr.info('Router stopped. New generations are available.', EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#scene-director-test-director', async () => {
        persistDirectorPanelFields();
        toastr.info('Running router test...', EXTENSION_LABEL);
        const decision = await runRouterTestRequest();
        const nextSpeaker = typeof decision === 'string' ? decision : decision?.nextSpeaker;
        if (sceneDirectorState.routerStatus !== 'stopped') {
            toastr.info(nextSpeaker ? `Next speaker: ${nextSpeaker}` : 'No response returned.', EXTENSION_LABEL);
        }
    });
    $('#scene-director-panel-body').on('click', '#scene-director-copy-prompt', async () => {
        await copyDirectorPromptToClipboard();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-clear-router', () => {
        clearActiveTriggerSettleMonitor();
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
            triggerSettle: null,
        });
    });
    $('#scene-director-panel-body').on('click', '#router-send-ooc, #router-send-ooc-toolbar', async () => {
        persistDirectorPanelFields();
        await runRouterOocRequest();
    });
    $('#scene-director-panel-body').on('click', '#router-clear-ooc', () => {
        sceneDirectorState.routerOocDraft = ROUTER_OOC_DEFAULT_DRAFT;
        refreshSceneDirectorPanel();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-clear-issue', () => {
        clearBackstageIssue();
    });
    $('#scene-director-panel-body').on('click', '#scene-director-clear-logs', () => {
        updateSceneDirectorState({
            operationLogs: (sceneDirectorState.operationLogs ?? []).filter(log => log.status === 'running'),
        });
    });
    $('#scene-director-panel-body').on('change', '#backstage-console-log-level', function () {
        config.consoleLogLevel = normalizeLogLevel($(this).val(), { fallback: DEFAULT_CONFIG.consoleLogLevel });
        saveConfig();
        backstageLogger.info('Core', `Console log level changed to ${config.consoleLogLevel}`);
    });
    $('#scene-director-panel-body').on('change', '#backstage-memory-search-logs', function () {
        config.memorySearchLogs = this.checked;
        saveConfig();
    });
    $('#scene-director-panel-body').on('focusout', '#router-input-token-budget, #router-prompt', () => {
        persistDirectorPanelFields();
    });
    $('#scene-director-panel-body').on('input', '#router-prompt', function () {
        config.routerPrompt = String($(this).val() ?? '');
        schedulePromptTokenCounterUpdate('router-prompt', 'router-prompt-token-counter');
        scheduleRouterPromptSave();
    });
    $('#scene-director-panel-body').on('change', '#router-input-token-budget', () => {
        persistDirectorPanelFields();
    });
    $('#scene-director-panel-body').on('focusout', '#router-ooc-request', () => {
        persistDirectorPanelFields();
    });
    $('#scene-director-panel-body').on('input', '#router-ooc-request', () => {
        sceneDirectorState.routerOocDraft = String($('#router-ooc-request').val() ?? '');
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
                        <small style="color:#888;">Use the floating ${EXTENSION_DISPLAY_NAME} panel to manage ${ROUTER_LABEL}, agents and logs.</small>
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

    if (!group) {
        return;
    }

    const groupCharacters = group.members
        .map(avatar => ctx.characters.find(c => c.avatar === avatar))
        .filter(Boolean);

    const existing    = config.characters || [];
    config.characters = groupCharacters.map(character => {
        const saved = existing.find(item => String(item.avatar ?? '') === String(character.avatar ?? ''))
            ?? existing.find(item => item.name === character.name);
        return normalizeCharacterConnection({
            ...(saved ?? {}),
            name: character.name,
            avatar: character.avatar,
        });
    });
    saveConfig();
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

async function initAgentProfileDropdown() {
    const agent = getSelectedAgent();
    if (!agent || !$('#agent-profile-dropdown').length) return;

    const service = await getConnService();
    service.handleDropdown(
        '#agent-profile-dropdown',
        agent.profileId,
        (profile) => {
            const current = getAgentDefinition(agent.id);
            if (!current) return;
            current.profileId = profile?.id ?? '';
            current.profileName = profile?.name ?? '';
            saveConfig();
        },
    );
}

async function initGlobalAgentProfileDropdown() {
    if (!$('#global-agent-profile').length) return;
    const service = await getConnService();
    service.handleDropdown('#global-agent-profile', config.globalAgentProfileId, profile => {
        config.globalAgentProfileId = profile?.id ?? '';
        config.globalAgentProfileName = profile?.name ?? '';
        saveConfig();
    });
}

async function initAgentWorldInfoSelect() {
    const agent = getSelectedAgent();
    const container = $('#agent-world-info-books');
    if (!agent || !container.length) return;

    try {
        const wi = await getWorldInfoModule();
        const worldNames = getAvailableWorldInfoNames(wi);
        const selected = new Set(Array.isArray(agent.worldInfoBooks) ? agent.worldInfoBooks : []);
        const options = worldNames
            .map((name, index) => {
                const id = `agent-world-info-book-${index}`;
                return `<label class="sd-checkbox-row" for="${id}">
                    <input id="${id}" type="checkbox" value="${escapeHtml(name)}" ${selected.has(name) ? 'checked' : ''}>
                    <span>${escapeHtml(name)}</span>
                </label>`;
            })
            .join('');

        container.html(options || '<div class="sd-muted">No lorebooks found.</div>');
        updateAgentWorldInfoCount();
    } catch (error) {
        backstageLogger.warn('UI', 'Failed to initialize Agent World Info select', error);
        container.html('<div class="sd-muted">Could not load lorebooks.</div>');
        updateAgentWorldInfoCount();
    }
}

async function initCharProfileDropdowns() {
    if (!$('.sd-character-connections').length) return;
    const service = await getConnService();
    config.characters.forEach((char, idx) => {
        if ($(`#char-generation-profile-${idx}`).length) {
            service.handleDropdown(
                `#char-generation-profile-${idx}`,
                char.profileId,
                profile => {
                    config.characters[idx].profileId = profile?.id ?? '';
                    config.characters[idx].profileName = profile?.name ?? '';
                    saveConfig();
                },
            );
        }
        if ($(`#char-agent-profile-${idx}`).length) {
            service.handleDropdown(
                `#char-agent-profile-${idx}`,
                char.agentProfileId,
                profile => {
                    config.characters[idx].agentProfileId = profile?.id ?? '';
                    config.characters[idx].agentProfileName = profile?.name ?? '';
                    saveConfig();
                },
            );
        }
    });
    await initGlobalAgentProfileDropdown();
}

function attachEvents() {
    $('#extensions_settings').on('change', '#router-enabled', () => {
        config.enabled = $('#router-enabled').is(':checked');
        saveConfig();
        toastr.success(config.enabled ? `${ROUTER_LABEL} enabled.` : `${ROUTER_LABEL} disabled.`, EXTENSION_LABEL);
    });
}

// ================= MAIN =================

jQuery(document).ready(async () => {
    loadConfig();
    loadGroupMembers();
    renderSettings();
    await renderSceneDirectorPanel();
    attachEvents();
    attachFloatingPanelEvents();
    startToggleStatusTicker();

    const ctx = SillyTavern.getContext();
    ctx.setExtensionPrompt?.(
        'scene-director-next-reply',
        '',
        EXTENSION_PROMPT_TYPES.IN_PROMPT,
        0,
        false,
        EXTENSION_PROMPT_ROLES.SYSTEM,
    );

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
    }, [], 'Executa o Turn Router manualmente');

    ctx.registerSlashCommand?.('routerwi', async () => {
        await testWorldInfoPrompt('slash:/routerwi');
        return '';
    }, [], 'Testa o World Info que seria injetado no prompt');

    window.MultiCaller = {
        ...(window.MultiCaller ?? {}),
        testWorldInfoPrompt,
        lastRouterRequest,
        logger: backstageLogger,
    };

    ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, async (type, _options, dryRun) => {
        if (dryRun) return;
        const diagnostics = await getToolCallingDiagnostics(type);
        backstageLogger.debug('ToolCall', 'Generation started', {
            type: String(type ?? 'normal'),
            activeCharacter: lastActiveChar || 'unknown',
            supported: diagnostics.supported,
            canPerform: diagnostics.canPerform,
            hostToolBlocks: summarizeHostChatForLog().toolCount,
            inspectionError: diagnostics.error || '',
        });
    });

    if (ctx.event_types.TOOL_CALLS_PERFORMED) {
        ctx.eventSource.on(ctx.event_types.TOOL_CALLS_PERFORMED, (invocations) => {
            backstageLogger.info('ToolCall', 'Tools performed and persisted to host chat', {
                invocations: summarizeToolInvocationsForConsole(invocations),
                hostToolBlocks: summarizeHostChatForLog().toolCount,
            });
        });
    }

    if (ctx.event_types.TOOL_CALLS_RENDERED) {
        ctx.eventSource.on(ctx.event_types.TOOL_CALLS_RENDERED, (invocations) => {
            backstageLogger.debug('ToolCall', 'Tool result block rendered', {
                count: Array.isArray(invocations) ? invocations.length : 0,
                hostToolBlocks: summarizeHostChatForLog().toolCount,
            });
        });
    }

    ctx.eventSource.on(ctx.event_types.USER_MESSAGE_RENDERED, () => {
        scheduleAgentsForTurn({
            type: 'user',
            label: 'Scheduled after user turn',
            characterName: String(SillyTavern.getContext().name1 ?? ''),
        });
        setTimeout(() => {
            handleUserTurnPipeline();
        }, 300);
    });

    ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, async messageId => {
        await handleCharacterTurnCandidate(messageId, 'CHARACTER_MESSAGE_RENDERED');
    });

    ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => {
        const c = SillyTavern.getContext();
        const lastMsg = c.chat[c.chat.length - 1];
        const type = lastMsg?.extra?.type;
        const isEmpty = !lastMsg?.mes?.trim();
        const isToolCycle = isEmpty || isToolInvocationChatMessage(lastMsg);
        fl('← EVT', 'GENERATION_ENDED', `isProcessing=${isProcessing} | type=${type ?? (isEmpty ? 'empty' : 'msg')} | toolCycle=${isToolCycle}`);
        if (isToolCycle) {
            fl('  =', 'GENERATION_ENDED', 'tool_call pendente — mantendo isProcessing');
            backstageLogger.debug('ToolCall', 'Generation ended on an intermediate tool cycle', {
                messageType: type || 'empty',
                isProcessing,
            });
            return;
        }
        backstageLogger.info(`Character:${String(lastMsg?.name ?? lastActiveChar ?? 'unknown')}`, 'Generation ended', {
            isProcessing,
            responseCharacters: String(lastMsg?.mes ?? '').length,
            pendingNativeTurn: !!pendingNativeCharacterMessage,
        });
        const pendingNativeMessage = pendingNativeCharacterMessage;
        const completedCharacterMessage = pendingNativeMessage
            ?? (lastMsg && !lastMsg.is_user && !lastMsg.is_system && !isToolInvocationChatMessage(lastMsg) ? lastMsg : null);
        pendingNativeCharacterMessage = completedCharacterMessage;
        if (!isProcessing) {
            if (completedCharacterMessage) {
                pendingAutoRouter = false;
                setTimeout(() => {
                    processCompletedCharacterMessage(completedCharacterMessage, 'GENERATION_ENDED:native-character');
                }, 0);
            } else if (pendingAutoRouter) {
                pendingAutoRouter = false;
                setTimeout(() => {
                    runRouter('GENERATION_ENDED:native-pending');
                }, 0);
            }
            return;
        }
        updateActiveOperationLog('character-turn', {
            response: String(lastMsg?.mes ?? ''),
            reasoning: String(lastMsg?.extra?.reasoning ?? ''),
        });
        clearCharacterNote();
        clearAgentCharacterInjection();
        clearDirectedOocPrompt();
        clearActiveTriggerSettleMonitor();
        finishRuntimePhase(['character-turn']);
        isProcessing = false;
        fl('  ✓', 'GENERATION_ENDED', 'isProcessing liberado');
        if (completedCharacterMessage) {
            pendingAutoRouter = false;
            setTimeout(() => {
                processCompletedCharacterMessage(completedCharacterMessage, 'GENERATION_ENDED:character');
            }, 0);
        } else if (pendingAutoRouter) {
            pendingAutoRouter = false;
            setTimeout(() => {
                runRouter('GENERATION_ENDED:pending-auto');
            }, 0);
        }
    });

    ctx.eventSource.on(ctx.event_types.GENERATION_STOPPED, () => {
        const stoppedContext = SillyTavern.getContext();
        memoryReinforcement.ignoreMessage(stoppedContext.chat?.at(-1));
        fl('← EVT', 'GENERATION_STOPPED', `isProcessing=${isProcessing}`);
        backstageLogger.warn('Generation', 'Generation stopped', { isProcessing });
        if (!isProcessing) {
            pendingAutoRouter = false;
            pendingNativeCharacterMessage = null;
            return;
        }
        clearCharacterNote();
        clearAgentCharacterInjection();
        clearDirectedOocPrompt();
        clearActiveTriggerSettleMonitor();
        finishRuntimePhase(['character-turn'], 'stopped');
        skipNextCharacterAutoRouter = false;
        pendingAutoRouter = false;
        pendingNativeCharacterMessage = null;
        isProcessing = false;
        fl('  ✓', 'GENERATION_STOPPED', 'isProcessing liberado (stop forçado)');
    });

    ctx.eventSource.on(ctx.event_types.GROUP_WRAPPER_FINISHED, async () => {
        const pendingMessage = pendingNativeCharacterMessage;
        if (!pendingMessage) {
            return;
        }

        pendingNativeCharacterMessage = null;
        backstageLogger.debug('Generation', 'Group wrapper finished; processing pending character turn', {
            character: String(pendingMessage?.name ?? 'unknown'),
            messageCharacters: String(pendingMessage?.mes ?? '').length,
        });
        await processCompletedCharacterMessage(pendingMessage, 'GROUP_WRAPPER_FINISHED');
    });

    ctx.eventSource.on(ctx.event_types.GROUP_MEMBER_DRAFTED, (charName) => {
        lastActiveChar = charName;
    });

    ctx.eventSource.on(ctx.event_types.CHAT_COMPLETION_PROMPT_READY, ({ chat, dryRun }) => {
        if (dryRun) return;

        const characterOperationLogId = getActiveOperationLogId('character-turn');
        const characterOperation = (sceneDirectorState.operationLogs ?? []).find(log => log.id === characterOperationLogId);
        const promptReadyNumber = Math.max(0, Number(characterOperation?.promptReadyCount) || 0) + 1;
        const beforeRemap = summarizeCompletionMessagesForLog(chat);
        const hostChat = summarizeHostChatForLog();
        const promptSummary = {
            promptReadyNumber,
            completionMessages: beforeRemap.total,
            completionRoles: beforeRemap.roles,
            toolCalls: beforeRemap.toolCalls,
            toolResults: beforeRemap.toolResults,
            hostMessages: hostChat.total,
            hostToolBlocks: hostChat.toolCount,
            activeCharacter: lastActiveChar || 'unknown',
        };
        backstageLogger.debug('ToolCall', 'Prompt assembled before Backstage remap', promptSummary);
        if (hostChat.toolCount > 0 && beforeRemap.toolCalls === 0 && beforeRemap.toolResults === 0) {
            backstageLogger.warn('ToolCall', 'Host chat contains tool blocks, but the assembled prompt does not', promptSummary);
        }
        if (characterOperationLogId) {
            updateOperationLog(characterOperationLogId, {
                promptReadyCount: promptReadyNumber,
            });
            appendOperationLogDetail(characterOperationLogId, [
                `Prompt ready ${promptReadyNumber} before remap`,
                `Completion messages: total=${beforeRemap.total}, nonSystem=${beforeRemap.nonSystem} (${beforeRemap.roles}), toolCalls=${beforeRemap.toolCalls}, toolResults=${beforeRemap.toolResults}`,
                `Host chat at prompt ready: total=${hostChat.total}, user=${hostChat.userCount}, character=${hostChat.characterCount}, system=${hostChat.systemCount}, tools=${hostChat.toolCount}`,
                `Host chat tail: ${hostChat.lastMessages}`,
                beforeRemap.nonSystem === 0 && (hostChat.userCount + hostChat.characterCount) > 0
                    ? 'ANOMALY: host chat exists, but Prompt Manager produced no non-system chat messages.'
                    : '',
            ].filter(Boolean).join('\n'));
        }

        const noteMsg    = chat.findLast(m => m.role === 'system' && m.content?.includes('Write the next reply only as '));
        const match      = noteMsg?.content?.match(/Write the next reply only as (.+?)\./);
        const activeChar = match?.[1];

        if (activeChar) {
            const normalizedActiveChar = String(activeChar).trim().toLocaleLowerCase();
            for (const msg of chat) {
                if (msg.role !== 'assistant' || msg.tool_calls != null || msg.function_call != null) continue;
                const messageName = String(msg.name ?? '').trim().toLocaleLowerCase();
                const contentHasActivePrefix = String(msg.content ?? '')
                    .trimStart()
                    .toLocaleLowerCase()
                    .startsWith(`${normalizedActiveChar}:`);
                const belongsToActiveCharacter = messageName
                    ? messageName === normalizedActiveChar
                    : contentHasActivePrefix;

                if (!belongsToActiveCharacter) {
                    msg.role = 'user';
                }
            }
        }

        const afterRemap = summarizeCompletionMessagesForLog(chat);
        if (characterOperationLogId) {
            appendOperationLogDetail(characterOperationLogId, [
                `Prompt ready ${promptReadyNumber} after remap`,
                `Completion messages: total=${afterRemap.total}, nonSystem=${afterRemap.nonSystem} (${afterRemap.roles}), toolCalls=${afterRemap.toolCalls}, toolResults=${afterRemap.toolResults}`,
            ].join('\n'));
        }
        backstageLogger.trace('ToolCall', 'Prompt after Backstage remap', {
            promptReadyNumber,
            completionMessages: afterRemap.total,
            completionRoles: afterRemap.roles,
            toolCalls: afterRemap.toolCalls,
            toolResults: afterRemap.toolResults,
        });
    });

    ctx.eventSource.on(ctx.event_types.CHAT_COMPLETION_SETTINGS_READY, (payload) => {
        try {
            captureCharacterApiRequest(payload);
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];
            backstageLogger.debug('ToolCall', 'Final character API request ready', {
                model: String(payload?.model ?? '-'),
                source: String(payload?.chat_completion_source ?? '-'),
                messages: messages.length,
                toolCalls: messages.filter(message => Array.isArray(message?.tool_calls) && message.tool_calls.length > 0).length,
                toolResults: messages.filter(message => message?.role === 'tool').length,
                registeredTools: Array.isArray(payload?.tools) ? payload.tools.length : 0,
                streaming: !!payload?.stream,
            });
        } catch (error) {
            backstageLogger.warn('ToolCall', 'Failed to capture character API request', error);
        }
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        noteTriggerSettleEvent('CHAT_CHANGED', `isProcessing=${isProcessing}`);
        lastActiveChar = null;
        loadGroupMembers();
    });

    ctx.eventSource.on(ctx.event_types.MAIN_API_CHANGED, (payload) => {
        noteTriggerSettleEvent('MAIN_API_CHANGED', payload?.apiId ?? '');
    });

    ctx.eventSource.on(ctx.event_types.CHATCOMPLETION_SOURCE_CHANGED, (payload) => {
        noteTriggerSettleEvent('CHATCOMPLETION_SOURCE_CHANGED', payload?.source ?? payload ?? '');
    });

    ctx.eventSource.on(ctx.event_types.OAI_PRESET_CHANGED_BEFORE, (payload) => {
        noteTriggerSettleEvent('OAI_PRESET_CHANGED_BEFORE', payload?.preset ?? payload?.name ?? '');
    });

    ctx.eventSource.on(ctx.event_types.OAI_PRESET_CHANGED_AFTER, (payload) => {
        noteTriggerSettleEvent('OAI_PRESET_CHANGED_AFTER', payload?.preset ?? payload?.name ?? '');
    });

    ctx.eventSource.on(ctx.event_types.CONNECTION_PROFILE_LOADED, (profileName) => {
        noteTriggerSettleEvent('CONNECTION_PROFILE_LOADED', profileName ?? '');
    });

    loadGroupMembers();
});
