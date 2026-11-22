// Pure helpers: no gi:// imports so they run under plain `gjs -m` tests.

const DESKTOP_SUFFIX = '.desktop';

/**
 * Lowercased identifiers a window can be matched by. Each `.desktop` ID is
 * also offered without its suffix so a rule `code` matches `code.desktop`.
 *
 * @param {object} ids
 * @param {string|null} [ids.appId]
 * @param {string|null} [ids.wmClass]
 * @param {string|null} [ids.wmClassInstance]
 * @param {string|null} [ids.sandboxedAppId]
 * @returns {string[]}
 */
export function ruleCandidates({appId, wmClass, wmClassInstance, sandboxedAppId} = {}) {
    const result = new Set();
    for (const value of [appId, wmClass, wmClassInstance, sandboxedAppId]) {
        if (!value)
            continue;
        const id = value.trim().toLowerCase();
        if (!id)
            continue;
        result.add(id);
        if (id.endsWith(DESKTOP_SUFFIX))
            result.add(id.slice(0, -DESKTOP_SUFFIX.length));
    }
    return [...result];
}

/**
 * @param {string[]} candidates output of ruleCandidates()
 * @param {string[]} rules app IDs or WM classes, case-insensitive
 * @returns {boolean}
 */
export function matchesRules(candidates, rules) {
    const wanted = new Set(
        (rules ?? []).map(r => r.trim().toLowerCase()).filter(r => r.length > 0));
    return candidates.some(c => wanted.has(c));
}

/**
 * @param {number} length
 * @param {number} index
 * @param {number} dir +1 or -1
 * @returns {number} wrapped index, or -1 for an empty list
 */
export function cycleIndex(length, index, dir) {
    if (length <= 0)
        return -1;
    return (((index + dir) % length) + length) % length;
}

/** Returns a new MRU list with `item` first. */
export function mruTouch(list, item) {
    return [item, ...list.filter(x => x !== item)];
}

/** Returns a new MRU list without `item`. */
export function mruRemove(list, item) {
    return list.filter(x => x !== item);
}

/** Copies an Mtk.Rectangle (or any {x, y, width, height}) into a plain object. */
export function rectFromMtk(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

export function rectEquals(a, b) {
    if (!a || !b)
        return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Comma-separated text → trimmed entries, empty ones dropped. */
export function splitList(text) {
    return text.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
