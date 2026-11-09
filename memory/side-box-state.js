const chats = new WeakMap();

/** Side memories are transient, scoped to a chat metadata object and exact memory source. */
export function getSideBox(ctx, sourceKey) {
    return chats.get(ctx.chatMetadata)?.get(sourceKey) ?? [];
}

/** Replace a turn's retrieval snapshot without persisting it or changing memory ratings. */
export function setSideBox(ctx, sourceKey, memories) {
    if (!chats.has(ctx.chatMetadata)) chats.set(ctx.chatMetadata, new Map());
    chats.get(ctx.chatMetadata).set(sourceKey, memories);
}

/** Clearing a finished, failed or stopped turn never removes persisted memories. */
export function clearSideBox(ctx, sourceKey) {
    chats.get(ctx.chatMetadata)?.delete(sourceKey);
}
