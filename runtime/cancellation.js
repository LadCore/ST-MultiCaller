function createAbortError(reason = 'Operation stopped by user.') {
    const error = new Error(String(reason || 'Operation stopped by user.'));
    error.name = 'AbortError';
    return error;
}

export function isAbortError(error) {
    return error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || /abort|cancel|stopp?ed/i.test(String(error?.message ?? ''));
}

export class CancellationRegistry {
    #operations = new Map();

    start(key, metadata = {}) {
        const normalizedKey = String(key ?? '').trim();
        if (!normalizedKey) throw new Error('Cancellation operation key is required.');
        if (this.#operations.has(normalizedKey)) {
            throw new Error(`Operation "${normalizedKey}" is already running.`);
        }

        const operation = {
            key: normalizedKey,
            token: Symbol(normalizedKey),
            controller: new AbortController(),
            metadata: { ...metadata },
            startedAt: new Date(),
        };
        this.#operations.set(normalizedKey, operation);
        return operation;
    }

    get(key) {
        return this.#operations.get(String(key ?? '').trim()) ?? null;
    }

    isActive(key) {
        return !!this.get(key);
    }

    assertActive(operation) {
        if (!operation || operation.controller.signal.aborted) {
            throw operation?.controller.signal.reason instanceof Error
                ? operation.controller.signal.reason
                : createAbortError(operation?.controller.signal.reason);
        }
        if (this.#operations.get(operation.key)?.token !== operation.token) {
            throw createAbortError('Operation was superseded or stopped.');
        }
    }

    stop(key, reason = 'Operation stopped by user.') {
        const operation = this.get(key);
        if (!operation) return null;
        this.#operations.delete(operation.key);
        operation.controller.abort(createAbortError(reason));
        return operation;
    }

    finish(operation) {
        if (!operation) return false;
        if (this.#operations.get(operation.key)?.token !== operation.token) return false;
        this.#operations.delete(operation.key);
        return true;
    }
}
