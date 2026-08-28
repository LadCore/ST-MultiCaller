const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export const AGENT_ACTION_STAGES = Object.freeze({
    JSON: 'json',
    SYNTAX: 'syntax',
    RUNTIME: 'runtime',
    RESULT: 'result',
});

export class AgentActionError extends Error {
    constructor(stage, message, options = {}) {
        super(message, options);
        this.name = 'AgentActionError';
        this.stage = stage;
    }
}

export function parseAgentActionPayload(rawOutput) {
    const source = String(rawOutput ?? '').trim();
    if (!source) {
        throw new AgentActionError(AGENT_ACTION_STAGES.JSON, 'The agent action output is empty.');
    }

    try {
        return JSON.parse(source);
    } catch (error) {
        throw new AgentActionError(
            AGENT_ACTION_STAGES.JSON,
            `The agent action output is not valid JSON: ${error?.message ?? String(error)}`,
            { cause: error },
        );
    }
}

function compileAgentAction(script) {
    const source = String(script ?? '').trim();
    if (!source) {
        throw new AgentActionError(AGENT_ACTION_STAGES.SYNTAX, 'The agent action script is empty.');
    }

    try {
        return new AsyncFunction(
            'payload',
            'rawOutput',
            'agent',
            'trigger',
            'context',
            'log',
            `"use strict";\n${source}`,
        );
    } catch (error) {
        throw new AgentActionError(
            AGENT_ACTION_STAGES.SYNTAX,
            `The agent action script has invalid JavaScript: ${error?.message ?? String(error)}`,
            { cause: error },
        );
    }
}

export function validateAgentActionScript(script) {
    try {
        compileAgentAction(script);
        return { valid: true, error: '' };
    } catch (error) {
        return {
            valid: false,
            error: error?.message ?? String(error),
            stage: error?.stage ?? AGENT_ACTION_STAGES.SYNTAX,
        };
    }
}

function serializeValue(value, label) {
    if (value === undefined) return 'undefined';

    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized === undefined ? String(value) : serialized;
    } catch (error) {
        throw new AgentActionError(
            AGENT_ACTION_STAGES.RESULT,
            `${label} could not be serialized: ${error?.message ?? String(error)}`,
            { cause: error },
        );
    }
}

export async function executeAgentAction({
    script,
    rawOutput,
    agent,
    trigger,
    context,
    onLog,
}) {
    const startedAt = performance.now();
    const payload = parseAgentActionPayload(rawOutput);
    const action = compileAgentAction(script);
    const messages = [];
    const log = (...values) => {
        const line = values.map(value => typeof value === 'string' ? value : serializeValue(value, 'Log value')).join(' ');
        messages.push(line);
        onLog?.(line, values);
    };

    let result;
    try {
        result = await action(payload, String(rawOutput ?? ''), agent, trigger, context, log);
    } catch (error) {
        if (error instanceof AgentActionError) throw error;
        throw new AgentActionError(
            AGENT_ACTION_STAGES.RUNTIME,
            `The agent action script failed: ${error?.message ?? String(error)}`,
            { cause: error },
        );
    }

    return {
        payload,
        payloadText: serializeValue(payload, 'Action payload'),
        result,
        resultText: serializeValue(result, 'Action result'),
        logs: messages,
        durationMs: Math.max(0, performance.now() - startedAt),
    };
}
