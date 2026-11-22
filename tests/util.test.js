import {
    ruleCandidates, matchesRules, cycleIndex, mruTouch, mruRemove, rectFromMtk, rectEquals, splitList,
} from '../growi@9ticks.github.io/util.js';
import {assertEqual, assertTrue, assertFalse} from './assert.js';

const DEFAULT_RULES = ['com.microsoft.VSCode.desktop', 'code.desktop', 'code-oss.desktop',
    'codium.desktop', 'Code', 'code'];
const vscodeWayland = ruleCandidates({appId: 'com.microsoft.VSCode.desktop'});
const vscodeXwayland = ruleCandidates({appId: 'window:12', wmClass: 'Code', wmClassInstance: 'code'});

export const tests = {
    'ruleCandidates lowercases, dedupes and strips .desktop'() {
        assertEqual(
            ruleCandidates({appId: 'Foo.desktop', wmClass: 'FOO', wmClassInstance: null, sandboxedAppId: ' '}),
            ['foo.desktop', 'foo']);
    },
    'matchesRules accepts the app ID rule case-insensitively'() {
        assertTrue(matchesRules(vscodeWayland, ['COM.Microsoft.vscode.DESKTOP']));
    },
    'matchesRules accepts an app ID without its .desktop suffix'() {
        assertTrue(matchesRules(vscodeWayland, ['com.microsoft.vscode']));
    },
    'matchesRules accepts the WM class rule case-insensitively'() {
        assertTrue(matchesRules(vscodeXwayland, ['Code']));
        assertTrue(matchesRules(ruleCandidates({wmClass: 'CODE'}), ['code']));
    },
    'matchesRules matches both VS Code variants with default rules'() {
        assertTrue(matchesRules(vscodeWayland, DEFAULT_RULES));
        assertTrue(matchesRules(vscodeXwayland, DEFAULT_RULES));
    },
    'matchesRules rejects other apps'() {
        assertFalse(matchesRules(ruleCandidates({appId: 'org.gnome.TextEditor.desktop'}), DEFAULT_RULES));
    },
    'matchesRules rejects when rules are empty or blank'() {
        assertFalse(matchesRules(vscodeWayland, []));
        assertFalse(matchesRules(vscodeWayland, ['', '  ']));
        assertFalse(matchesRules(ruleCandidates({}), ['']));
    },
    'matchesRules trims rules'() {
        assertTrue(matchesRules(vscodeXwayland, ['  Code  ']));
    },
    'cycleIndex wraps forward and backward'() {
        assertEqual(cycleIndex(3, 0, 1), 1);
        assertEqual(cycleIndex(3, 2, 1), 0);
        assertEqual(cycleIndex(3, 0, -1), 2);
        assertEqual(cycleIndex(1, 0, -1), 0);
    },
    'cycleIndex returns -1 for an empty list'() {
        assertEqual(cycleIndex(0, 0, 1), -1);
    },
    'mruTouch moves the item first without mutating the input'() {
        const list = ['a', 'b', 'c'];
        assertEqual(mruTouch(list, 'c'), ['c', 'a', 'b']);
        assertEqual(mruTouch(list, 'd'), ['d', 'a', 'b', 'c']);
        assertEqual(list, ['a', 'b', 'c']);
    },
    'mruRemove drops the item without mutating the input'() {
        const list = ['a', 'b', 'c'];
        assertEqual(mruRemove(list, 'b'), ['a', 'c']);
        assertEqual(list, ['a', 'b', 'c']);
    },
    'rectFromMtk copies the four fields and rectEquals compares them'() {
        const r = rectFromMtk({x: 1, y: 2, width: 3, height: 4, extra: true});
        assertEqual(r, {x: 1, y: 2, width: 3, height: 4});
        assertTrue(rectEquals(r, {x: 1, y: 2, width: 3, height: 4}));
        assertFalse(rectEquals(r, {x: 1, y: 2, width: 3, height: 5}));
        assertFalse(rectEquals(r, null));
    },
    'splitList trims entries and drops empty ones'() {
        assertEqual(splitList(' code.desktop,, Code ,  ,google-chrome.desktop, '),
            ['code.desktop', 'Code', 'google-chrome.desktop']);
        assertEqual(splitList('  '), []);
    },
};
