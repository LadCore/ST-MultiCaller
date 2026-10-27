import { normalizeSummaryConfig } from '../memory/character-summary.js';

export const AGENT_OWNER_TYPES = Object.freeze({
    GLOBAL: 'global',
    CHARACTER: 'character',
});

export const AGENT_CONNECTION_MODES = Object.freeze({
    PARENT: 'parent',
    PROFILE: 'profile',
});

export const CHARACTER_AGENT_CONNECTION_MODES = Object.freeze({
    GENERATION: 'generation',
    PROFILE: 'profile',
});

export function normalizeCharacterConnection(character) {
    return {
        name: String(character?.name ?? '').trim(),
        avatar: String(character?.avatar ?? ''),
        profileId: String(character?.profileId ?? ''),
        profileName: String(character?.profileName ?? ''),
        agentProfileMode: character?.agentProfileMode === CHARACTER_AGENT_CONNECTION_MODES.PROFILE
            ? CHARACTER_AGENT_CONNECTION_MODES.PROFILE
            : CHARACTER_AGENT_CONNECTION_MODES.GENERATION,
        agentProfileId: String(character?.agentProfileId ?? ''),
        agentProfileName: String(character?.agentProfileName ?? ''),
        summary: normalizeSummaryConfig(character?.summary),
    };
}

export function normalizeAgentConnection(agent) {
    return {
        ownerType: agent?.ownerType === AGENT_OWNER_TYPES.CHARACTER
            ? AGENT_OWNER_TYPES.CHARACTER
            : AGENT_OWNER_TYPES.GLOBAL,
        ownerCharacterAvatar: String(agent?.ownerCharacterAvatar ?? ''),
        ownerCharacterName: String(agent?.ownerCharacterName ?? '').trim(),
        connectionMode: agent?.connectionMode === AGENT_CONNECTION_MODES.PROFILE
            ? AGENT_CONNECTION_MODES.PROFILE
            : AGENT_CONNECTION_MODES.PARENT,
    };
}

export function getAgentOwnerKey(agent) {
    if (agent?.ownerType !== AGENT_OWNER_TYPES.CHARACTER) return AGENT_OWNER_TYPES.GLOBAL;
    const identity = String(agent?.ownerCharacterAvatar || agent?.ownerCharacterName || '').trim();
    return identity ? `${AGENT_OWNER_TYPES.CHARACTER}:${identity}` : AGENT_OWNER_TYPES.GLOBAL;
}

export function findCharacterConnection(agent, characters = []) {
    const avatar = String(agent?.ownerCharacterAvatar ?? '');
    const name = String(agent?.ownerCharacterName ?? '').trim().toLowerCase();
    return (Array.isArray(characters) ? characters : []).find(character => avatar && String(character?.avatar ?? '') === avatar)
        ?? (Array.isArray(characters) ? characters : []).find(character => name && String(character?.name ?? '').trim().toLowerCase() === name)
        ?? null;
}

export function resolveAgentConnection(agent, config) {
    if (agent?.connectionMode === AGENT_CONNECTION_MODES.PROFILE) {
        return createResolution(agent?.profileId, agent?.profileName, 'agent', 'Agent override');
    }

    if (agent?.ownerType === AGENT_OWNER_TYPES.CHARACTER) {
        const character = findCharacterConnection(agent, config?.characters);
        if (!character) return createResolution('', '', 'missing-character', 'Character block unavailable');

        if (character.agentProfileMode === CHARACTER_AGENT_CONNECTION_MODES.PROFILE) {
            return createResolution(character.agentProfileId, character.agentProfileName, 'character-agent', `${character.name} Agent Connection`);
        }

        return createResolution(character.profileId, character.profileName, 'character-generation', `${character.name} Generation Connection`);
    }

    return createResolution(config?.globalAgentProfileId, config?.globalAgentProfileName, 'global-agent', 'Global Agent Connection');
}

function createResolution(profileId, profileName, source, label) {
    const id = String(profileId ?? '').trim();
    const name = String(profileName ?? '').trim();
    return {
        profileId: id,
        profileName: name,
        source,
        label,
        configured: !!(id || name),
    };
}
