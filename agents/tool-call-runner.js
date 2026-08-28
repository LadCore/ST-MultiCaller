import { ToolManager } from '/scripts/tool-calling.js';

const DEFAULT_MAX_TOOL_ROUNDS = 16;
const MAX_TOOL_ROUNDS = 64;

function extractAssistantMessage(response) {
    const message = response?.choices?.[0]?.message
        ?? response?.message
        ?? response?.data?.choices?.[0]?.message
        ?? null;

    if (!message || typeof message !== 'object') {
        throw new Error('Tool-enabled agent response did not contain an assistant message.');
    }
    return message;
}

function extractMessageText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content
        .map(part => typeof part === 'string' ? part : String(part?.text ?? ''))
        .join('');
}

function extractReasoning(message, response) {
    return String(
        message?.reasoning_content
        ?? message?.reasoning
        ?? message?.thinking
        ?? response?.reasoning
        ?? '',
    );
}

function normalizeToolCalls(message) {
    return (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
        .filter(call => call?.function?.name)
        .map((call, index) => ({
            ...call,
            id: String(call.id ?? `backstage-tool-${Date.now()}-${index}`),
            type: String(call.type ?? 'function'),
            function: {
                ...call.function,
                name: String(call.function.name),
                arguments: typeof call.function.arguments === 'string'
                    ? call.function.arguments
                    : JSON.stringify(call.function.arguments ?? {}),
            },
        }));
}

function stringifyToolResult(result) {
    return result instanceof Error ? result.toString() : String(result ?? '');
}

export async function runAgentToolConversation({
    messages,
    tools,
    validateToolCall = () => {},
    sendRawRequest,
    onEvent = () => {},
    maxRounds = DEFAULT_MAX_TOOL_ROUNDS,
    signal = null,
}) {
    const schemas = Array.isArray(tools) ? tools : [];
    if (!schemas.length) throw new Error('Tool-enabled agent request has no permitted tools.');

    const allowedToolNames = new Set(
        schemas.map(tool => String(tool?.function?.name ?? '').trim()).filter(Boolean),
    );
    const conversation = structuredClone(Array.isArray(messages) ? messages : []);
    const reasoningParts = [];
    const toolEvents = [];
    const roundLimit = Math.min(MAX_TOOL_ROUNDS, Math.max(1, Number(maxRounds) || DEFAULT_MAX_TOOL_ROUNDS));

    for (let round = 1; round <= roundLimit; round += 1) {
        signal?.throwIfAborted();
        onEvent({
            type: 'request',
            round,
            messageCount: conversation.length,
            messages: structuredClone(conversation),
            tools: structuredClone(schemas),
        });
        const response = await sendRawRequest(conversation, schemas);
        signal?.throwIfAborted();
        const assistant = extractAssistantMessage(response);
        const content = extractMessageText(assistant);
        const reasoning = extractReasoning(assistant, response);
        const toolCalls = normalizeToolCalls(assistant);

        if (reasoning) reasoningParts.push(reasoning);
        onEvent({ type: 'response', round, content, reasoning, toolCalls });

        if (!toolCalls.length) {
            return {
                content,
                reasoning: reasoningParts.join('\n\n'),
                rounds: round,
                toolEvents,
                messages: conversation,
            };
        }

        conversation.push({
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
            signal?.throwIfAborted();
            const name = toolCall.function.name;
            const argumentsText = toolCall.function.arguments;
            let result;

            try {
                if (!allowedToolNames.has(name)) {
                    throw new Error(`Tool "${name}" is not enabled for this agent request.`);
                }
                validateToolCall(name, argumentsText);
                result = await ToolManager.invokeFunctionTool(name, argumentsText);
                signal?.throwIfAborted();
            } catch (error) {
                if (signal?.aborted) throw signal.reason ?? error;
                result = error instanceof Error ? error : new Error(String(error));
            }

            const resultText = stringifyToolResult(result);
            const event = {
                type: 'tool-result',
                round,
                id: toolCall.id,
                name,
                arguments: argumentsText,
                result: resultText,
                error: result instanceof Error,
            };
            toolEvents.push(event);
            onEvent(event);
            conversation.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name,
                content: resultText,
            });
        }
    }

    throw new Error(`Agent exceeded the ${roundLimit}-round tool-call limit without returning a final answer.`);
}
