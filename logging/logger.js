const PREFIX = 'Backstage';
const STARTED_AT = performance.now();

const LEVELS = Object.freeze({
    off: -1,
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
});

const LEVEL_STYLES = Object.freeze({
    error: 'color:#ff8a80;font-weight:700',
    warn: 'color:#ffd166;font-weight:700',
    info: 'color:#68d8ff;font-weight:700',
    debug: 'color:#c5a3ff;font-weight:700',
    trace: 'color:#a7adb7;font-weight:700',
});

const CONSOLE_METHODS = Object.freeze({
    error: 'error',
    warn: 'warn',
    info: 'info',
    debug: 'debug',
    trace: 'debug',
});

export const LOG_LEVEL_OPTIONS = Object.freeze(['off', 'error', 'warn', 'info', 'debug', 'trace']);
export const AGENT_LOG_LEVEL_OPTIONS = Object.freeze(['inherit', ...LOG_LEVEL_OPTIONS]);

let globalLevel = 'info';
const scopeLevels = new Map();

export function normalizeLogLevel(value, { allowInherit = false, fallback = 'info' } = {}) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (allowInherit && normalized === 'inherit') return 'inherit';
    return Object.hasOwn(LEVELS, normalized) ? normalized : fallback;
}

function normalizeScope(value) {
    return String(value ?? 'Core').trim() || 'Core';
}

function resolveScopeLevel(scope) {
    const override = scopeLevels.get(normalizeScope(scope));
    return override && override !== 'inherit' ? override : globalLevel;
}

function shouldWrite(level, scope) {
    const normalizedLevel = normalizeLogLevel(level, { fallback: 'info' });
    const threshold = resolveScopeLevel(scope);
    return LEVELS[threshold] >= 0 && LEVELS[normalizedLevel] <= LEVELS[threshold];
}

function write(level, scope, message, data) {
    const normalizedLevel = normalizeLogLevel(level, { fallback: 'info' });
    const normalizedScope = normalizeScope(scope);
    if (!shouldWrite(normalizedLevel, normalizedScope)) return false;

    const elapsed = ((performance.now() - STARTED_AT) / 1000).toFixed(2);
    const method = CONSOLE_METHODS[normalizedLevel] || 'log';
    const prefix = `[${PREFIX}][${normalizedLevel.toUpperCase()}][${normalizedScope}][+${elapsed}s]`;
    const args = [
        `%c[${PREFIX}]%c[${normalizedLevel.toUpperCase()}]%c[${normalizedScope}]%c[+${elapsed}s] ${String(message ?? '')}`,
        'color:#6ee7b7;font-weight:700',
        LEVEL_STYLES[normalizedLevel],
        'color:#f2f4f8;font-weight:600',
        'color:#8f96a3;font-weight:400',
    ];
    if (data.length) args.push(...data);

    try {
        console[method](...args);
    } catch {
        console.log(prefix, message, ...data);
    }
    return true;
}

export const backstageLogger = Object.freeze({
    configure({ level = globalLevel, scopes = null } = {}) {
        globalLevel = normalizeLogLevel(level, { fallback: 'info' });
        if (scopes && typeof scopes === 'object') {
            scopeLevels.clear();
            for (const [scope, scopeLevel] of Object.entries(scopes)) {
                const normalized = normalizeLogLevel(scopeLevel, { allowInherit: true, fallback: 'inherit' });
                if (normalized !== 'inherit') scopeLevels.set(normalizeScope(scope), normalized);
            }
        }
    },

    setGlobalLevel(level) {
        globalLevel = normalizeLogLevel(level, { fallback: 'info' });
    },

    setScopeLevel(scope, level = 'inherit') {
        const normalizedScope = normalizeScope(scope);
        const normalizedLevel = normalizeLogLevel(level, { allowInherit: true, fallback: 'inherit' });
        if (normalizedLevel === 'inherit') scopeLevels.delete(normalizedScope);
        else scopeLevels.set(normalizedScope, normalizedLevel);
    },

    getGlobalLevel() {
        return globalLevel;
    },

    getScopeLevel(scope) {
        return scopeLevels.get(normalizeScope(scope)) ?? 'inherit';
    },

    isEnabled(level, scope = 'Core') {
        return shouldWrite(level, scope);
    },

    error(scope, message, ...data) {
        return write('error', scope, message, data);
    },

    warn(scope, message, ...data) {
        return write('warn', scope, message, data);
    },

    info(scope, message, ...data) {
        return write('info', scope, message, data);
    },

    debug(scope, message, ...data) {
        return write('debug', scope, message, data);
    },

    trace(scope, message, ...data) {
        return write('trace', scope, message, data);
    },
});
