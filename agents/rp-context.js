/** Treat absent or invalid offsets as zero, preserving existing agent configurations. */
export function normalizeContextMessageOffset(value) {
    const offset = Number(value);
    return Number.isFinite(offset) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(offset))) : 0;
}

/** Exclude positions from the full chat before any RP filters; source objects retain their identity. */
export function sliceChatBeforeOffset(chat, offset = 0) {
    const messages = Array.isArray(chat) ? chat : [];
    return messages.slice(0, Math.max(0, messages.length - normalizeContextMessageOffset(offset)));
}

/** Hidden RP messages share is_system with host notices; only known speakers may bypass that flag. */
export function selectRpMessages(chat, { includeHidden = false, characterNames = [], isOoc = () => false } = {}) {
    const names = new Set(characterNames);
    return (Array.isArray(chat) ? chat : []).filter(message => {
        if (!message || !String(message.mes ?? '').trim() || isOoc(message.mes)) return false;
        if (['tool_call', 'tool_response'].includes(message.extra?.type) || message.extra?.tool_invocations?.length) return false;
        if (!message.is_system) return true;
        return includeHidden && !message.extra?.type
            && (message.is_user === true || !!message.original_avatar || names.has(message.name));
    });
}

/** Format copied prompt text; retain original source indices and never replace stored message.mes. */
export function formatAgentMessages(messages, chat, { humanName = '', withIndices = false, regexTransform = null } = {}) {
    const indices = withIndices ? new Map(chat.flatMap((message, index) => message ? [[message, index + 1]] : [])) : null;
    return messages.map((message, index) => {
        const raw = String(message.mes ?? '');
        const text = regexTransform ? regexTransform(raw, !!message.is_user, messages.length - index - 1) : raw;
        if (typeof text !== 'string') throw new Error('ST prompt regex did not return text.');
        const content = humanName ? text.replace(/{{user}}/gi, humanName) : text;
        const sourceIndex = indices?.get(message);
        if (withIndices && !sourceIndex) throw new Error('A summary source message no longer belongs to this chat.');
        return `${withIndices ? `[message_index=${sourceIndex}] ` : ''}${message.name || 'Unknown'}: ${content}`;
    });
}
