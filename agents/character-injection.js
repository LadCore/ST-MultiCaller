export const AGENT_INJECTION_POSITIONS = Object.freeze({
    BEFORE_MAIN: 'before-main',
    AFTER_MAIN: 'after-main',
    IN_CHAT: 'in-chat',
});

const PROMPT_TYPES = Object.freeze({
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

const PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

const activePromptKeys = new Set();

export function normalizeAgentInjectionPlacement(agent) {
    const requestedPosition = String(agent?.characterInjectionPosition ?? '');
    const position = Object.values(AGENT_INJECTION_POSITIONS).includes(requestedPosition)
        ? requestedPosition
        : AGENT_INJECTION_POSITIONS.IN_CHAT;
    const depth = Math.min(9999, Math.max(0, parseInt(agent?.characterInjectionDepth) || 0));
    const requestedRole = Number(agent?.characterInjectionRole);
    const role = Object.values(PROMPT_ROLES).includes(requestedRole)
        ? requestedRole
        : PROMPT_ROLES.SYSTEM;

    return {
        position,
        depth: position === AGENT_INJECTION_POSITIONS.IN_CHAT ? depth : 0,
        role: position === AGENT_INJECTION_POSITIONS.IN_CHAT ? role : PROMPT_ROLES.SYSTEM,
    };
}

export function formatAgentInjectionPlacement(agent) {
    const placement = normalizeAgentInjectionPlacement(agent);
    if (placement.position === AGENT_INJECTION_POSITIONS.BEFORE_MAIN) return 'Before Main Prompt / System';
    if (placement.position === AGENT_INJECTION_POSITIONS.AFTER_MAIN) return 'After Main Prompt / System';

    const roleNames = ['System', 'User', 'Assistant'];
    return `In-chat @ depth ${placement.depth} / ${roleNames[placement.role]}`;
}

function getPromptSettings(agent) {
    const placement = normalizeAgentInjectionPlacement(agent);
    if (placement.position === AGENT_INJECTION_POSITIONS.BEFORE_MAIN) {
        return { type: PROMPT_TYPES.BEFORE_PROMPT, depth: 0, role: PROMPT_ROLES.SYSTEM };
    }
    if (placement.position === AGENT_INJECTION_POSITIONS.AFTER_MAIN) {
        return { type: PROMPT_TYPES.IN_PROMPT, depth: 0, role: PROMPT_ROLES.SYSTEM };
    }
    return { type: PROMPT_TYPES.IN_CHAT, depth: placement.depth, role: placement.role };
}

function buildPromptKey(baseKey, agentId) {
    const safeAgentId = String(agentId ?? 'agent').replace(/[^a-z0-9_-]+/gi, '-');
    return `${baseKey}:${safeAgentId}`;
}

export function clearAgentCharacterInjectionPrompts(ctx, baseKey) {
    if (typeof ctx?.setExtensionPrompt !== 'function') return;

    ctx.setExtensionPrompt(baseKey, '', PROMPT_TYPES.IN_PROMPT, 0, false, PROMPT_ROLES.SYSTEM);
    for (const key of activePromptKeys) {
        ctx.setExtensionPrompt(key, '', PROMPT_TYPES.IN_PROMPT, 0, false, PROMPT_ROLES.SYSTEM);
    }
    activePromptKeys.clear();
}

export function applyAgentCharacterInjectionPrompts(ctx, baseKey, injections) {
    clearAgentCharacterInjectionPrompts(ctx, baseKey);
    if (typeof ctx?.setExtensionPrompt !== 'function') return [];

    const applied = [];
    for (const injection of Array.isArray(injections) ? injections : []) {
        const key = buildPromptKey(baseKey, injection.agent?.id);
        const settings = getPromptSettings(injection.agent);
        ctx.setExtensionPrompt(
            key,
            String(injection.prompt ?? ''),
            settings.type,
            settings.depth,
            false,
            settings.role,
        );
        activePromptKeys.add(key);
        applied.push({ ...injection, key, settings });
    }

    return applied;
}
