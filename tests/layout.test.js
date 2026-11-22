import {
    dissolveLayout, formLayout, maximizedContent, offsetRect, resizeLayout, shortenTitle,
} from '../growi@9ticks.github.io/layout.js';
import {assertEqual} from './assert.js';

const BAR = 30;
// Work area below a 32 px top panel on a 1600x1000 monitor.
const WORK_AREA = {x: 0, y: 32, width: 1600, height: 968};
const CONTENT = {x: 0, y: 62, width: 1600, height: 938};

const form = (frame, maximizeFlags = 0) =>
    formLayout({frame, workArea: WORK_AREA, barHeight: BAR, maximizeFlags});
const dissolve = (frame, carved = 'top') => dissolveLayout({frame, workArea: WORK_AREA, barHeight: BAR, carved});

const resize = (frame, carved, barHeight = 40) =>
    resizeLayout({frame, workArea: WORK_AREA, oldBarHeight: BAR, barHeight, carved});

export const tests = {
    'maximizedContent is the work area below the bar'() {
        assertEqual(maximizedContent(WORK_AREA, BAR), CONTENT);
    },
    'formLayout carves a fully maximized window from the work area'() {
        assertEqual(form({...WORK_AREA}, 3), {content: CONTENT, carved: 'maximize'});
        // Even while the frame has not caught up with the maximize yet.
        assertEqual(form({x: 100, y: 200, width: 800, height: 600}, 3), {content: CONTENT, carved: 'maximize'});
    },
    'formLayout carves a tiled window within its tile'() {
        assertEqual(form({x: 800, y: 32, width: 800, height: 968}, 2),
            {content: {x: 800, y: 62, width: 800, height: 938}, carved: 'top'});
    },
    'formLayout carves a frame whose top is within one bar height of the work area'() {
        assertEqual(form({x: 10, y: 61, width: 500, height: 400}),
            {content: {x: 10, y: 91, width: 500, height: 370}, carved: 'top'});
        assertEqual(form({x: 10, y: 32, width: 500, height: 400}),
            {content: {x: 10, y: 62, width: 500, height: 370}, carved: 'top'});
        assertEqual(form({x: 10, y: 0, width: 500, height: 400}),
            {content: {x: 10, y: 62, width: 500, height: 338}, carved: 'top'});
    },
    'formLayout keeps a frame with room for the bar above it'() {
        const frame = {x: 10, y: 62, width: 500, height: 400};
        assertEqual(form(frame), {content: frame, carved: null});
    },
    'dissolveLayout maximizes a window filling the work area below the bar'() {
        assertEqual(dissolve(CONTENT), {action: 'maximize', rect: WORK_AREA});
    },
    'dissolveLayout extends a window whose top strip was taken'() {
        assertEqual(dissolve({x: 800, y: 62, width: 800, height: 938}),
            {action: 'extend', rect: {x: 800, y: 32, width: 800, height: 968}});
    },
    'dissolveLayout leaves other frames alone'() {
        assertEqual(dissolve({x: 0, y: 63, width: 1600, height: 937}), {action: 'none', rect: null});
        assertEqual(dissolve({x: 10, y: 61, width: 500, height: 400}), {action: 'none', rect: null});
    },
    'resizeLayout carves a maximize carve for the new height'() {
        assertEqual(resize(CONTENT, 'maximize'),
            {content: {x: 0, y: 72, width: 1600, height: 928}, carved: 'maximize'});
    },
    'resizeLayout moves a top carve to the new height'() {
        assertEqual(resize({x: 800, y: 62, width: 800, height: 938}, 'top'),
            {content: {x: 800, y: 72, width: 800, height: 928}, carved: 'top'});
        // Back to a smaller bar: the frame gives less of its top.
        assertEqual(resize({x: 800, y: 62, width: 800, height: 938}, 'top', 20),
            {content: {x: 800, y: 52, width: 800, height: 948}, carved: 'top'});
    },
    'resizeLayout keeps an uncarved frame while the new bar fits above it'() {
        const frame = {x: 100, y: 200, width: 800, height: 600};
        assertEqual(resize(frame, null), {content: frame, carved: null});
    },
    'resizeLayout carves an uncarved frame the new bar no longer fits above'() {
        assertEqual(resize({x: 100, y: 65, width: 800, height: 600}, null),
            {content: {x: 100, y: 105, width: 800, height: 560}, carved: 'top'});
    },
    'dissolveLayout maximizes a maximize carve whatever the frame says'() {
        assertEqual(dissolve({x: 0, y: 32, width: 1431, height: 838}, 'maximize'),
            {action: 'maximize', rect: WORK_AREA});
    },
    'dissolveLayout leaves an uncarved window alone'() {
        assertEqual(dissolve(CONTENT, null), {action: 'none', rect: null});
        assertEqual(dissolve({x: 10, y: 62, width: 500, height: 400}, null), {action: 'none', rect: null});
    },
    'offsetRect moves down-right and stays inside the work area'() {
        assertEqual(offsetRect({x: 10, y: 100, width: 500, height: 400}, WORK_AREA, 60),
            {x: 70, y: 160, width: 500, height: 400});
        assertEqual(offsetRect(CONTENT, WORK_AREA, 60), {x: 60, y: 122, width: 1540, height: 878});
    },
    'shortenTitle strips a trailing app name after any dash'() {
        const app = 'Visual Studio Code';
        assertEqual(shortenTitle('main.ts - growi - Visual Studio Code', app), 'main.ts - growi');
        assertEqual(shortenTitle('main.ts — growi — Visual Studio Code', app), 'main.ts — growi');
        assertEqual(shortenTitle('main.ts – Visual Studio Code', app), 'main.ts');
    },
    'shortenTitle keeps titles without the app suffix'() {
        assertEqual(shortenTitle('main.ts - growi', 'Visual Studio Code'), 'main.ts - growi');
        assertEqual(shortenTitle('Visual Studio Code', 'Visual Studio Code'), 'Visual Studio Code');
        assertEqual(shortenTitle('notes', null), 'notes');
    },
    'shortenTitle falls back to the app name for empty titles'() {
        assertEqual(shortenTitle('', 'Text Editor'), 'Text Editor');
        assertEqual(shortenTitle(null, 'Text Editor'), 'Text Editor');
        assertEqual(shortenTitle('  ', null), '');
    },
};
