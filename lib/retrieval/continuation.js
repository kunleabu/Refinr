const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateSourceState(name, state) {
    // null = exhausted; {} = not yet successfully fetched; otherwise a native page token.
    if (state === null) return;
    if (!isObject(state)) throw new TypeError('Invalid source continuation');
    const keys = Object.keys(state);
    if (!keys.length) return;
    if (name === 'openalex') {
        if (keys.length !== 1 || keys[0] !== 'cursor' || typeof state.cursor !== 'string' || !state.cursor.trim() || state.cursor.length > 8192) throw new TypeError('Invalid OpenAlex continuation');
    } else if (name === 'crossref') {
        if (keys.length !== 1 || keys[0] !== 'offset' || !Number.isInteger(state.offset) || state.offset < 0 || state.offset > 10000) throw new TypeError('Invalid Crossref continuation');
    }
}
export function validateContinuation(continuation, constraints, sourceNames) {
    if (continuation === undefined || continuation === null) return;
    if (!isObject(continuation) || continuation.version !== 1 || continuation.query !== constraints.query || continuation.yearFrom !== constraints.yearFrom || continuation.yearTo !== constraints.yearTo || !isObject(continuation.sources)) throw new TypeError('Continuation does not match this search');
    const keys = Object.keys(continuation.sources);
    if (keys.length !== sourceNames.length || sourceNames.some(name => !Object.hasOwn(continuation.sources, name))) throw new TypeError('Incomplete source continuation');
    for (const name of sourceNames) validateSourceState(name, continuation.sources[name]);
}
