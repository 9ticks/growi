// Pure geometry and title helpers for the tabbed layout: no gi:// imports so
// they run under plain `gjs -m` tests. Rects are {x, y, width, height}.

import {rectEquals} from './util.js';

// Meta.MaximizeFlags.BOTH, duplicated to keep this module free of gi:// imports.
const MAXIMIZE_BOTH = 3;
const TITLE_SEPARATORS = [' - ', ' — ', ' – '];

/** The rect a window takes in a fully maximized group: the work area below the bar. */
export function maximizedContent(workArea, barHeight) {
    return {
        x: workArea.x,
        y: workArea.y + barHeight,
        width: workArea.width,
        height: workArea.height - barHeight,
    };
}

/**
 * Decides where the active window goes when a group gets its bar. The bar sits
 * above the frame; when there is no room for it there (maximized, tiled, or
 * top within one bar height of the work area) its height is taken out of the
 * window instead.
 *
 * `carved` records how, for dissolveLayout(): `'maximize'` (the work area
 * below the bar), `'top'` (the frame's top strip) or null (frame kept).
 *
 * @returns {{content: object, carved: 'maximize'|'top'|null}}
 */
export function formLayout({frame, workArea, barHeight, maximizeFlags}) {
    if (maximizeFlags === MAXIMIZE_BOTH)
        return {content: maximizedContent(workArea, barHeight), carved: 'maximize'};
    if (maximizeFlags === 0 && frame.y - barHeight >= workArea.y)
        return {content: {...frame}, carved: null};

    const top = Math.max(frame.y, workArea.y) + barHeight;
    const bottom = frame.y + frame.height;
    return {
        content: {x: frame.x, y: top, width: frame.width, height: Math.max(1, bottom - top)},
        carved: 'top',
    };
}

/**
 * Undoes formLayout() when a group loses its bar: a window carved from a
 * full maximize, or filling the work area below the bar, is maximized again;
 * one whose top was taken for the bar gets that strip back; anything else is
 * left alone. `carved` is the value formLayout() returned: it decides on its
 * own for `'maximize'`, since the frame may still lag behind a pending move.
 *
 * @returns {{action: 'maximize'|'extend'|'none', rect: object|null}}
 */
export function dissolveLayout({frame, workArea, barHeight, carved = 'top'}) {
    if (!carved)
        return {action: 'none', rect: null};
    if (carved === 'maximize' || rectEquals(frame, maximizedContent(workArea, barHeight)))
        return {action: 'maximize', rect: {...workArea}};
    if (frame.y === workArea.y + barHeight) {
        return {
            action: 'extend',
            rect: {x: frame.x, y: workArea.y, width: frame.width, height: frame.height + barHeight},
        };
    }
    return {action: 'none', rect: null};
}

/**
 * formLayout() for a new bar height, starting from the geometry
 * dissolveLayout() would give back for the old one, so the window moves once,
 * straight to its new rect, without going through that intermediate geometry.
 *
 * @returns {{content: object, carved: 'maximize'|'top'|null}}
 */
export function resizeLayout({frame, workArea, oldBarHeight, barHeight, carved}) {
    const {action, rect} = dissolveLayout({frame, workArea, barHeight: oldBarHeight, carved});
    if (action === 'maximize')
        return formLayout({frame: rect, workArea, barHeight, maximizeFlags: MAXIMIZE_BOTH});
    return formLayout({frame: action === 'extend' ? rect : frame, workArea, barHeight, maximizeFlags: 0});
}

/**
 * `rect` moved by `offset` down and right, shrunk so it stays inside the work
 * area; used to put a detached window where it does not hide its old group.
 */
export function offsetRect(rect, workArea, offset) {
    const x = Math.min(rect.x + offset, workArea.x + workArea.width - 1);
    const y = Math.min(rect.y + offset, workArea.y + workArea.height - 1);
    return {
        x,
        y,
        width: Math.max(1, Math.min(rect.width, workArea.x + workArea.width - x)),
        height: Math.max(1, Math.min(rect.height, workArea.y + workArea.height - y)),
    };
}

/** Drops a trailing ` - <App Name>` (any dash); an empty title shows the app name. */
export function shortenTitle(title, appName) {
    const text = (title ?? '').trim();
    if (!text)
        return appName ?? '';
    if (!appName)
        return text;
    for (const separator of TITLE_SEPARATORS) {
        const suffix = `${separator}${appName}`;
        if (text.endsWith(suffix) && text.length > suffix.length)
            return text.slice(0, -suffix.length);
    }
    return text;
}

