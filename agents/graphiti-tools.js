import { ToolManager } from '/scripts/tool-calling.js';

const GRAPHITI_API_URL = 'http://127.0.0.1:8091';
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const GRAPHITI_TOOL_NAMES = Object.freeze({
    status: 'backstage_memory_status',
    search: 'backstage_search_memory',
    remember: 'backstage_remember_memory',
    correct: 'backstage_correct_memory',
    forget: 'backstage_forget_memory',
});

const TOOL_DEFINITIONS = [
    {
        name: GRAPHITI_TOOL_NAMES.status,
        displayName: 'Backstage Memory Status',
        description: 'Check whether the Backstage long-term memory service is available. Use this only to diagnose availability or configuration. It does not search, create, change, or delete memories.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        action: async () => callGraphiti('/health'),
        formatMessage: () => 'Checking long-term memory service',
    },
    {
        name: GRAPHITI_TOOL_NAMES.search,
        displayName: 'Search Backstage Memory',
        description: 'Search long-term RP memories semantically. Use before relying on an old event, before correcting or deleting memory, and whenever recent context is insufficient. Search only the groups explicitly permitted in the group_ids parameter. Treat facts with invalid_at as historical or superseded, not currently true. Never invent a fact UUID.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Focused semantic question describing the event, belief, relationship, place, or fact to recall.',
                },
                group_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    description: 'Exact memory groups to search. Use only group IDs listed as permitted in this description.',
                },
                num_results: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 10,
                    description: 'Maximum number of matching facts to return.',
                },
            },
            required: ['query', 'group_ids'],
            additionalProperties: false,
        },
        action: parameters => callGraphiti('/search', {
            method: 'POST',
            body: {
                query: String(parameters.query ?? '').trim(),
                group_ids: normalizeGroupIds(parameters.group_ids),
                num_results: Math.min(50, Math.max(1, Number(parameters.num_results) || 10)),
            },
        }),
        formatMessage: parameters => `Searching long-term memory for: ${String(parameters?.query ?? '').trim()}`,
    },
    {
        name: GRAPHITI_TOOL_NAMES.remember,
        displayName: 'Remember in Backstage Memory',
        description: 'Store a new durable RP memory in long-term memory. Use for events, discoveries, decisions, relationships, persistent beliefs, injuries, promises, and other information likely to matter later. Do not store transient prose, momentary chain-of-thought, writing instructions, future plans, or facts the perspective character could not know. A later event that changes an earlier belief is a new memory, not a correction.',
        parameters: {
            type: 'object',
            properties: {
                group_id: {
                    type: 'string',
                    description: 'Exact destination memory group. It must match the only writable group stated in this description.',
                },
                name: {
                    type: 'string',
                    description: 'Short unique label identifying this memory batch or RP interval.',
                },
                content: {
                    type: 'string',
                    description: 'Compact durable memory written from the required epistemic perspective. State who knows, believes, witnessed, inferred, or remains uncertain when relevant.',
                },
                source_description: {
                    type: 'string',
                    description: 'Short provenance such as character memory update, GM canonical tracker, or manual OOC correction.',
                },
                reference_time: {
                    type: 'string',
                    description: 'Optional ISO-8601 time when the remembered event occurred. Omit when unavailable.',
                },
            },
            required: ['group_id', 'name', 'content'],
            additionalProperties: false,
        },
        action: rememberMemory,
        formatMessage: parameters => `Writing long-term memory: ${String(parameters?.name ?? '').trim()}`,
    },
    {
        name: GRAPHITI_TOOL_NAMES.correct,
        displayName: 'Correct Backstage Memory',
        description: 'Correct a fact that was inaccurate from the moment it was recorded. Always call the memory search tool first and use the exact fact_uuid and group_id returned by it. Do not use when the world changed later or a character learned new information; store that later development with the remember tool instead. This operation invalidates the inaccurate fact and records an authoritative correction.',
        parameters: {
            type: 'object',
            properties: {
                fact_uuid: {
                    type: 'string',
                    description: 'Exact UUID returned by memory search. Never guess, shorten, or invent it.',
                },
                group_id: {
                    type: 'string',
                    description: 'Exact group_id returned with the target fact. It must also match the writable group.',
                },
                corrected_memory: {
                    type: 'string',
                    description: 'Precise replacement memory, including perspective and uncertainty where relevant.',
                },
                reason: {
                    type: 'string',
                    description: 'Why the stored fact is inaccurate rather than merely outdated by a later event.',
                },
                reference_time: {
                    type: 'string',
                    description: 'Optional ISO-8601 time associated with the correction.',
                },
            },
            required: ['fact_uuid', 'group_id', 'corrected_memory', 'reason'],
            additionalProperties: false,
        },
        action: parameters => callGraphiti(`/facts/${encodeURIComponent(String(parameters.fact_uuid ?? '').trim())}/corrections`, {
            method: 'POST',
            body: {
                group_id: String(parameters.group_id ?? '').trim(),
                corrected_memory: String(parameters.corrected_memory ?? '').trim(),
                reason: String(parameters.reason ?? '').trim(),
                ...(parameters.reference_time ? { reference_time: String(parameters.reference_time) } : {}),
            },
        }),
        formatMessage: () => 'Correcting an inaccurate long-term memory',
    },
    {
        name: GRAPHITI_TOOL_NAMES.forget,
        displayName: 'Forget Backstage Memory',
        description: 'Permanently delete an incorrectly stored fact, episode, or entire memory group. This is destructive administration, not normal story evolution. Always search or inspect first. Use only when the user explicitly asks to remove data. Prefer correction when a false fact should be replaced, and prefer remember when later events changed what was true.',
        parameters: {
            type: 'object',
            properties: {
                resource: {
                    type: 'string',
                    enum: ['fact', 'episode', 'group'],
                    description: 'Exact resource type to delete.',
                },
                uuid: {
                    type: 'string',
                    description: 'Exact fact or episode UUID obtained from search or inspection. Omit only for group deletion.',
                },
                group_id: {
                    type: 'string',
                    description: 'Exact owning group. It must match the writable group. For group deletion this is also the confirmation value.',
                },
                reason: {
                    type: 'string',
                    description: 'Explicit reason the data must be permanently removed.',
                },
            },
            required: ['resource', 'group_id', 'reason'],
            additionalProperties: false,
        },
        action: forgetMemory,
        formatMessage: parameters => `Permanently deleting long-term ${String(parameters?.resource ?? 'memory')}`,
    },
];

let registered = false;

function normalizeGroupIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean))];
}

function assertValidGroupId(groupId) {
    if (!GROUP_ID_PATTERN.test(groupId)) {
        throw new Error(`Invalid group_id "${groupId}". Use only letters, numbers, dashes, and underscores.`);
    }
}

async function readJsonResponse(response) {
    const text = await response.text();
    let payload = null;
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { raw: text };
        }
    }
    if (!response.ok) {
        const detail = payload?.detail ?? payload?.raw ?? response.statusText;
        throw new Error(`Long-term memory API ${response.status}: ${detail}`);
    }
    return payload ?? {};
}

async function callGraphiti(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${GRAPHITI_API_URL}${path}`, {
        method,
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return readJsonResponse(response);
}

async function deterministicEpisodeUuid(parameters) {
    const source = JSON.stringify({
        group_id: parameters.group_id,
        name: parameters.name,
        content: parameters.content,
        reference_time: parameters.reference_time ?? null,
    });
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const hex = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function rememberMemory(parameters) {
    const groupId = String(parameters.group_id ?? '').trim();
    assertValidGroupId(groupId);
    const payload = {
        idempotency_key: await deterministicEpisodeUuid(parameters),
        name: String(parameters.name ?? '').trim(),
        content: String(parameters.content ?? '').trim(),
        group_id: groupId,
        source_description: String(parameters.source_description ?? 'Backstage agent memory').trim(),
        source: 'text',
        ...(parameters.reference_time ? { reference_time: String(parameters.reference_time) } : {}),
    };
    return callGraphiti('/episodes', { method: 'POST', body: payload });
}

async function forgetMemory(parameters) {
    const resource = String(parameters.resource ?? '').trim();
    const uuid = String(parameters.uuid ?? '').trim();
    const groupId = String(parameters.group_id ?? '').trim();
    assertValidGroupId(groupId);

    if (resource === 'fact') {
        if (!uuid) throw new Error('uuid is required when deleting a fact.');
        return callGraphiti(`/facts/${encodeURIComponent(uuid)}?group_id=${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    }
    if (resource === 'episode') {
        if (!uuid) throw new Error('uuid is required when deleting an episode.');
        const episode = await callGraphiti(`/episodes/${encodeURIComponent(uuid)}`);
        if (episode.group_id !== groupId) throw new Error('Episode does not belong to the requested group.');
        return callGraphiti(`/episodes/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
    }
    if (resource === 'group') {
        return callGraphiti(`/groups/${encodeURIComponent(groupId)}?confirm=${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    }
    throw new Error('resource must be fact, episode, or group.');
}

function ensureToolsRegistered() {
    if (registered) return;
    ToolManager.unregisterFunctionTool('backstage_graphiti_memory');
    for (const definition of TOOL_DEFINITIONS) {
        ToolManager.registerFunctionTool({
            ...definition,
            shouldRegister: () => false,
            stealth: true,
        });
    }
    registered = true;
}

function cloneSchema(name) {
    const definition = TOOL_DEFINITIONS.find(item => item.name === name);
    return definition ? structuredClone({
        type: 'function',
        function: {
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
        },
    }) : null;
}

function validatePolicyCall(policy, name, rawArguments) {
    let parameters;
    try {
        parameters = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : rawArguments ?? {};
    } catch (error) {
        throw new Error(`Invalid JSON arguments for ${name}: ${error.message}`);
    }

    if (!policy.allowedToolNames.has(name)) {
        throw new Error(`Tool ${name} is not permitted for this agent in ${policy.mode} mode.`);
    }

    if (name === GRAPHITI_TOOL_NAMES.search) {
        const requested = normalizeGroupIds(parameters.group_ids);
        if (!requested.length) throw new Error('At least one group_id is required for memory search.');
        const unauthorized = requested.filter(groupId => !policy.readGroupIds.includes(groupId));
        if (unauthorized.length) throw new Error(`Unauthorized memory groups: ${unauthorized.join(', ')}.`);
    }

    if ([GRAPHITI_TOOL_NAMES.remember, GRAPHITI_TOOL_NAMES.correct, GRAPHITI_TOOL_NAMES.forget].includes(name)) {
        const groupId = String(parameters.group_id ?? '').trim();
        if (!policy.writeGroupId || groupId !== policy.writeGroupId) {
            throw new Error(`This agent may write only to group "${policy.writeGroupId || 'none'}".`);
        }
    }

    return parameters;
}

export function buildAgentGraphitiToolRuntime(agent, mode = 'ooc') {
    ensureToolsRegistered();
    const automatic = mode === 'automatic';
    const enabled = automatic ? agent?.graphitiAutomaticEnabled === true : agent?.graphitiOocEnabled === true;
    if (!enabled) return null;

    const readGroupIds = normalizeGroupIds(agent?.graphitiReadGroupIds);
    const writeGroupId = String(agent?.graphitiWriteGroupId ?? '').trim();
    const configuredPermissions = automatic
        ? agent?.graphitiAutomaticPermissions
        : agent?.graphitiOocPermissions;
    const permissions = new Set(Array.isArray(configuredPermissions) ? configuredPermissions : []);
    const toolNames = [GRAPHITI_TOOL_NAMES.status];
    if (permissions.has('search') && readGroupIds.length) toolNames.push(GRAPHITI_TOOL_NAMES.search);
    if (permissions.has('remember') && writeGroupId) toolNames.push(GRAPHITI_TOOL_NAMES.remember);
    if (permissions.has('correct') && writeGroupId) toolNames.push(GRAPHITI_TOOL_NAMES.correct);
    if (permissions.has('forget') && writeGroupId) toolNames.push(GRAPHITI_TOOL_NAMES.forget);

    const schemas = toolNames.map(cloneSchema).filter(Boolean);
    const readableText = readGroupIds.length ? readGroupIds.join(', ') : 'none';
    const writableText = writeGroupId || 'none';
    for (const schema of schemas) {
        if (schema.function.name === GRAPHITI_TOOL_NAMES.search) {
            schema.function.description += ` Permitted groups for this agent: ${readableText}.`;
            schema.function.parameters.properties.group_ids.description += ` Permitted exact values: ${readableText}.`;
        }
        if ([GRAPHITI_TOOL_NAMES.remember, GRAPHITI_TOOL_NAMES.correct, GRAPHITI_TOOL_NAMES.forget].includes(schema.function.name)) {
            schema.function.description += ` This agent's only writable group is ${writableText}.`;
            schema.function.parameters.properties.group_id.description += ` Required exact value: ${writableText}.`;
        }
    }

    const policy = {
        mode,
        readGroupIds,
        writeGroupId,
        allowedToolNames: new Set(toolNames),
    };
    return {
        schemas,
        validateCall: (name, rawArguments) => validatePolicyCall(policy, name, rawArguments),
        summary: `${mode}; read=${readableText}; write=${writableText}; tools=${toolNames.join(', ')}`,
    };
}

export function isValidGraphitiGroupId(value) {
    return GROUP_ID_PATTERN.test(String(value ?? '').trim());
}
