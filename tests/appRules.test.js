import {resolveRule, isCovered, filterApps, hasRule, addRule, removeRule} from '../growi@9ticks.github.io/appRules.js';
import {ruleCandidates, matchesRules} from '../growi@9ticks.github.io/util.js';
import {assertEqual, assertTrue, assertFalse} from './assert.js';

const DEFAULT_RULES = ['com.microsoft.VSCode.desktop', 'code.desktop', 'code-oss.desktop',
    'codium.desktop', 'Code', 'code'];
const CHROME = {id: 'google-chrome.desktop', name: 'Google Chrome', startupWmClass: null, keywords: ['browser']};
const VSCODE = {id: 'com.microsoft.VSCode.desktop', name: 'Visual Studio Code',
    startupWmClass: 'com.microsoft.VSCode', keywords: []};
const TERM = {id: 'org.example.Term.desktop', name: 'terminal', startupWmClass: 'Termwork', keywords: ['shell']};
const APPS = [VSCODE, TERM, CHROME];

export const tests = {
    'resolveRule matches a desktop ID with or without .desktop, case-insensitively'() {
        for (const rule of ['google-chrome.desktop', 'google-chrome', 'GOOGLE-CHROME.desktop']) {
            const r = resolveRule(rule, APPS);
            assertEqual([r.rule, r.kind, r.app?.id], [rule, 'app', 'google-chrome.desktop'], rule);
        }
    },
    'resolveRule matches a StartupWMClass'() {
        const r = resolveRule('termwork', APPS);
        assertEqual([r.kind, r.app?.id], ['wm-class', 'org.example.Term.desktop']);
    },
    'resolveRule returns missing-app for an unresolved .desktop rule'() {
        assertEqual(resolveRule('code.desktop', APPS), {rule: 'code.desktop', app: null, kind: 'missing-app'});
        assertEqual(resolveRule(' Codium.DESKTOP ', []).kind, 'missing-app');
    },
    'resolveRule returns unknown (a WM class) for any other unresolved rule'() {
        assertEqual(resolveRule('Code', APPS), {rule: 'Code', app: null, kind: 'unknown'});
        assertEqual(resolveRule('code', APPS).kind, 'unknown');
        assertEqual(resolveRule('firefox', []).kind, 'unknown');
    },
    'isCovered agrees with the extension matching for the default rules'() {
        for (const app of APPS) {
            const expected = matchesRules(
                ruleCandidates({appId: app.id, wmClass: app.startupWmClass}), DEFAULT_RULES);
            assertEqual(isCovered(app, DEFAULT_RULES), expected, app.id);
        }
        assertTrue(isCovered(VSCODE, DEFAULT_RULES));
        assertFalse(isCovered(CHROME, DEFAULT_RULES));
        assertTrue(isCovered(TERM, ['TERMWORK']));
    },
    'filterApps sorts by name case-insensitively and keeps all for a blank query'() {
        assertEqual(filterApps(APPS, '  ').map(a => a.name), ['Google Chrome', 'terminal', 'Visual Studio Code']);
    },
    'filterApps matches name, ID and keywords case-insensitively'() {
        assertEqual(filterApps(APPS, 'CHROME').map(a => a.id), ['google-chrome.desktop']);
        assertEqual(filterApps(APPS, 'microsoft').map(a => a.id), ['com.microsoft.VSCode.desktop']);
        assertEqual(filterApps(APPS, ' Shell ').map(a => a.id), ['org.example.Term.desktop']);
        assertEqual(filterApps(APPS, 'nothing'), []);
    },
    'filterApps does not mutate its input'() {
        const apps = [...APPS];
        filterApps(apps, '');
        assertEqual(apps, APPS);
    },
    'hasRule compares trimmed and case-insensitively'() {
        assertTrue(hasRule(DEFAULT_RULES, ' CODE.desktop '));
        assertFalse(hasRule(DEFAULT_RULES, 'code-oss'));
    },
    'addRule appends the trimmed rule without mutating the input'() {
        const rules = ['Code'];
        assertEqual(addRule(rules, '  Termwork  '), ['Code', 'Termwork']);
        assertEqual(rules, ['Code']);
    },
    'addRule ignores empty input and case-insensitive duplicates'() {
        const rules = ['Code'];
        assertEqual(addRule(rules, '   '), ['Code']);
        assertEqual(addRule(rules, ' code '), ['Code']);
        assertFalse(addRule(rules, 'code') === rules, 'returns a new list');
    },
    'removeRule removes only the exact entry without mutating the input'() {
        const rules = ['Code', 'code', 'x', 'code'];
        assertEqual(removeRule(rules, 'code'), ['Code', 'x', 'code']);
        assertEqual(removeRule(rules, 'CODE'), rules);
        assertEqual(rules, ['Code', 'code', 'x', 'code']);
    },
};
