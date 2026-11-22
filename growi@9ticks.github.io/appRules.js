// Pure helpers for the app-rules editor: no gi:// imports so they run under
// plain `gjs -m` tests. Apps are plain objects {id, name, startupWmClass, keywords}.
// Matching goes through util.js so "already added" agrees with what the
// extension groups.

import {ruleCandidates, matchesRules} from './util.js';

const DESKTOP_SUFFIX = '.desktop';

const matchesId = (app, rule) => matchesRules(ruleCandidates({appId: app.id}), [rule]);
const matchesWmClass = (app, rule) =>
    matchesRules(ruleCandidates({wmClass: app.startupWmClass}), [rule]);

/**
 * @param {string} rule
 * @param {object[]} apps
 * @returns {{rule: string, app: object|null, kind: 'app'|'wm-class'|'missing-app'|'unknown'}}
 *   A desktop ID match wins over a StartupWMClass match. Without a match, a
 *   `.desktop` rule is `'missing-app'` (an app that is not installed) and any
 *   other rule `'unknown'` (taken as a WM class).
 */
export function resolveRule(rule, apps) {
    const byId = apps.find(app => matchesId(app, rule));
    if (byId)
        return {rule, app: byId, kind: 'app'};
    const byWmClass = apps.find(app => matchesWmClass(app, rule));
    if (byWmClass)
        return {rule, app: byWmClass, kind: 'wm-class'};
    const kind = rule.trim().toLowerCase().endsWith(DESKTOP_SUFFIX) ? 'missing-app' : 'unknown';
    return {rule, app: null, kind};
}

export function isCovered(app, rules) {
    return matchesRules(ruleCandidates({appId: app.id, wmClass: app.startupWmClass}), rules);
}

/**
 * Apps sorted by name, case-insensitively, keeping those whose name, ID or a
 * keyword contains the trimmed query (all of them for a blank query).
 */
export function filterApps(apps, query) {
    const needle = query.trim().toLowerCase();
    const contains = text => (text ?? '').toLowerCase().includes(needle);
    return apps
        .filter(app => !needle || contains(app.name) || contains(app.id) ||
            (app.keywords ?? []).some(contains))
        .sort((a, b) => compareNames(a.name, b.name));
}

function compareNames(a, b) {
    return (a ?? '').toLowerCase().localeCompare((b ?? '').toLowerCase());
}

/** Whether an entry equal to `rule` (trimmed, case-insensitive) exists. */
export function hasRule(rules, rule) {
    const wanted = rule.trim().toLowerCase();
    return rules.some(r => r.trim().toLowerCase() === wanted);
}

/** Returns a new list with the trimmed rule appended, or a copy when it is empty or present. */
export function addRule(rules, rule) {
    const trimmed = rule.trim();
    if (!trimmed || hasRule(rules, trimmed))
        return [...rules];
    return [...rules, trimmed];
}

/**
 * Returns a new list without the first entry exactly equal to `rule`, so a
 * row's remove button drops only that row even when the setting holds the
 * same string twice.
 */
export function removeRule(rules, rule) {
    const index = rules.indexOf(rule);
    if (index < 0)
        return [...rules];
    return [...rules.slice(0, index), ...rules.slice(index + 1)];
}
