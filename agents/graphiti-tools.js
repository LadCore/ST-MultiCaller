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
        description: 'Diagnose memory service availability or configuration when the operator requests it or a memory operation fails. Do not call as a routine prerequisite or follow-up to other memory tools. A successful search or write already confirms availability. Returns service configuration, not RP memories.',
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
        description: 'Retrieve missing past RP facts by semantic search. Reuse recent context, persisted output, and results already returned in this run when sufficient. Plan missing topics first: use one focused query per related topic, include relevant permitted groups together, and emit independent searches as tool calls in the same assistant response. Search again only for a specific unresolved information need, not to paraphrase a successful query or confirm a completed write. Stop when the evidence suffices for the assigned task. Empty results mean no match, not proof an event never happened. Returns facts with exact UUIDs, group IDs, and temporal fields; invalidated or expired facts are historical, not current.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'A focused information need naming the relevant characters and event, relationship, or period. Combine closely related questions about that topic. For example: "What did Mirella witness about Aiko during the escape from Mills?" Do not repeat an answered question with different wording.',
                },
                group_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    description: 'All permitted groups relevant to this query, searched together in one call. Do not make a separate call per group for the same question. Use only the exact group IDs listed as permitted.',
                },
                num_results: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 10,
                    description: 'Maximum matching facts. Default 10 suits a focused question; request more, up to 50, when the task needs a broader history instead of repeating the same query with gradually larger limits. Fewer than requested is a valid result.',
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
        description: 'Store new durable RP events, discoveries, decisions, relationships, persistent beliefs, injuries, or promises. Group related facts from the same event or RP interval into one coherent episode rather than one call per fact. Reuse available context and previous search results; search first only when missing history is needed to distinguish new information from an existing memory. Do not rewrite memories already stored in this run. Do not store transient prose, momentary chain-of-thought, writing instructions, future plans, or facts the perspective character could not know. A later development is a new memory, not a correction. Success returns episode_uuid, group_id, entity_count, and fact_count: the write completed, so do not search or write again merely to verify it.',
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
                    description: 'One coherent event or RP interval containing its related durable facts, using the required perspective and voice. State who knows, believes, witnessed, inferred, or remains uncertain. Preserve distinct events and their order; omit facts already stored unless new information changes them.',
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
        action: async parameters => summarizeMemoryWrite(await rememberMemory(parameters)),
        formatMessage: parameters => `Writing long-term memory: ${String(parameters?.name ?? '').trim()}`,
    },
    {
        name: GRAPHITI_TOOL_NAMES.correct,
        displayName: 'Correct Backstage Memory',
        description: 'Replace a fact that was inaccurate when recorded. Use the exact fact UUID and group ID from a search result already available in this run; search first only if that evidence is missing. Never invent identifiers. A later world change or newly learned information belongs in remember instead. Success invalidates the inaccurate fact and records its correction; use the returned result without a confirmation search or repeated correction.',
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
        description: 'Permanently delete a fact, episode, or entire group only when the operator explicitly requests removal. Reuse exact identifiers and ownership from results already available in this run; search or inspect only if needed to identify the requested target. Never guess UUIDs or delete memories because of normal story evolution. Use correct for an originally false fact and remember for a later development. A successful deletion is final; no confirmation search or repeated deletion is needed.',
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

async function callGraphiti(path, { method = 'GET', body, signal = null } = {}) {
    const response = await fetch(`${GRAPHITI_API_URL}${path}`, {
        method,
        cache: 'no-store',
        signal,
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

function summarizeMemoryWrite(result) {
    return {
        episode_uuid: result.episode_uuid,
        group_id: result.group_id,
        entity_count: result.entities?.length ?? 0,
        fact_count: result.facts?.length ?? 0,
    };
}

async function rememberMemory(parameters, signal = null) {
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
    return callGraphiti('/episodes', { method: 'POST', body: payload, signal });
}

export function getLongTermMemoryStatus(signal = null) {
    return callGraphiti('/health', { signal });
}

export function searchLongTermMemory({ query, groupIds, count = 8 }, signal = null) {
    const normalizedGroups = normalizeGroupIds(Array.isArray(groupIds) ? groupIds : String(groupIds ?? '').split(/[\s,]+/));
    if (!normalizedGroups.length) throw new Error('At least one readable memory group is required.');
    return callGraphiti('/search', {
        method: 'POST',
        signal,
        body: {
            query: String(query ?? '').trim(),
            group_ids: normalizedGroups,
            num_results: Math.min(50, Math.max(1, Number(count) || 8)),
        },
    });
}

export function ingestLongTermMemoryEpisode({ groupId, name, content, sourceDescription, referenceTime }, signal = null) {
    return rememberMemory({
        group_id: groupId,
        name,
        content,
        source_description: sourceDescription,
        reference_time: referenceTime,
    }, signal);
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
