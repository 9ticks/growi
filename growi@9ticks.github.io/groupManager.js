import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {offsetRect} from './layout.js';
import {TabBar} from './tabBar.js';
import {TabGroup, showWindow} from './tabGroup.js';
import {matchesRules, ruleCandidates} from './util.js';

const CYCLE_KEYBINDINGS = [['next-tab', 1], ['previous-tab', -1]];
const TOGGLE_KEYBINDING = 'toggle-grouping';

/**
 * Discovers groupable windows and indexes them into per-app, per-workspace
 * TabGroups.
 */
export class GroupManager {
    constructor(settings) {
        this._settings = settings;
        this._tracker = Shell.WindowTracker.get_default();

        this._groups = new Set();
        this._groupOf = new Map();
        /** Windows the user took out of a group; never auto-grouped again until unmanaged. */
        this._detached = new Set();
        /** Windows attached regardless of the app rules. */
        this._forced = new Set();

        this._watched = new Map();
        this._firstFrame = new Map();
        this._idleSources = new Map();
        this._wmClassWaits = new Map();
        this._displaySignals = [];
        this._settingsSignals = [];

        this._connectSettings();
        this._connectDisplay();
        this._addKeybindings();
        for (const win of this._allWindows())
            this._maybeGroup(win, {activate: false});
    }

    get settings() {
        return this._settings;
    }

    /** Group size from which a group shows its tab bar. */
    get minTabs() {
        return this._settings.get_boolean('show-single-tab') ? 1 : 2;
    }

    groupFor(win) {
        return this._groupOf.get(win) ?? null;
    }

    forEachGroup(fn) {
        for (const group of [...this._groups])
            fn(group);
    }

    /**
     * Puts `win` into the group of its app on its workspace, creating it if
     * needed. Idempotent. `force` ignores the app rules and is remembered
     * until the window is unmanaged.
     *
     * @returns {TabGroup|null}
     */
    attach(win, {activate = false, force = false} = {}) {
        if (!isGroupable(win))
            return null;
        const existing = this.groupFor(win);
        if (existing)
            return existing;
        const appId = this._groupAppId(win);
        if (!appId)
            return null;

        this._watch(win);
        this._detached.delete(win);
        if (force)
            this._forced.add(win);

        const workspace = win.get_workspace();
        let group = this._findGroup(appId, workspace);
        if (!group) {
            group = new TabGroup(this, appId, workspace);
            group.setView(new TabBar(group, this, this._barHeight()));
            this._groups.add(group);
        }
        group.add(win, {activate});
        return group;
    }

    /**
     * Takes `win` out of its group and leaves it visible, at `rect` when
     * given.
     */
    detach(win, {focus = false, rect = null} = {}) {
        const group = this.groupFor(win);
        if (!group)
            return;
        this._watch(win);
        this._forced.delete(win);
        this._detached.add(win);
        group.remove(win, {release: true, focus, rect});
    }

    /**
     * Detaches `win`, focused and offset from its group's slot so it does not
     * hide the group it leaves.
     */
    detachAside(win) {
        const group = this.groupFor(win);
        if (group)
            this.detach(win, {focus: true, rect: asideRect(group, win, 1)});
    }

    /** Groups every existing window that now qualifies (e.g. after a rules change). */
    refreshAll() {
        for (const win of this._allWindows())
            this._maybeGroup(win, {activate: false});
    }

    /**
     * Releases the members the app rules no longer cover, fanned out from the
     * slot so they do not hide each other, then groups the windows they now
     * cover. Forced and detached windows keep their state.
     */
    regroup() {
        this.forEachGroup(group => {
            const released = group.windows.filter(win => !this._forced.has(win) && !this._matchesRules(win));
            this._releaseFannedOut(group, released);
        });
        this.refreshAll();
    }

    // The hidden tabs go first, so the front tab is still active when the
    // group drops below `minTabs` and gets its layout dissolved. A group
    // released entirely keeps its front tab in place.
    _releaseFannedOut(group, released) {
        const hidden = released.filter(win => win !== group.active);
        const ordered = released.includes(group.active) ? [...hidden, group.active] : hidden;
        const keepFront = ordered.length === group.size;
        // Computed upfront: the slot and the view change as members leave.
        const rects = ordered.map((win, i) =>
            asideRect(group, win, keepFront && win === group.active ? 0 : i + 1));
        ordered.forEach((win, i) => group.remove(win, {release: true, rect: rects[i]}));
    }

    destroy() {
        for (const [name] of CYCLE_KEYBINDINGS)
            Main.wm.removeKeybinding(name);
        Main.wm.removeKeybinding(TOGGLE_KEYBINDING);
        for (const [obj, id] of [...this._displaySignals, ...this._settingsSignals])
            obj.disconnect(id);
        this._displaySignals = [];
        this._settingsSignals = [];

        for (const win of [...this._watched.keys()])
            this._forget(win);
        for (const group of [...this._groups])
            group.destroy();

        this._groups.clear();
        this._groupOf.clear();
        this._detached.clear();
        this._forced.clear();
        this._settings = null;
    }

    // --- TabGroup owner callbacks ---

    onMemberAdded(group, win) {
        this._groupOf.set(win, group);
    }

    onMemberRemoved(group, win) {
        if (this._groupOf.get(win) === group)
            this._groupOf.delete(win);
    }

    onGroupEmpty(group) {
        this._groups.delete(group);
        group.destroy();
    }

    /** A member left the group's workspace on its own. */
    onMemberMovedAway(group, win) {
        group.remove(win);
        // A hidden window with no tab to represent it would look lost.
        if (!this._maybeGroup(win, {activate: false}))
            showWindow(win);
    }

    /** The whole group followed its active window to another workspace. */
    onGroupMoved(group) {
        for (const other of [...this._groups]) {
            if (other !== group && other.appId === group.appId && other.workspace === group.workspace)
                group.absorb(other);
        }
    }

    // --- Settings ---

    _connectSettings() {
        const handlers = {
            'app-rules': () => this.regroup(),
            'tab-bar-height': () => this._onBarHeightChanged(),
            'show-single-tab': () => this._onShowSingleTabChanged(),
        };
        for (const [key, handler] of Object.entries(handlers)) {
            this._settingsSignals.push(
                [this._settings, this._settings.connect(`changed::${key}`, handler)]);
            // GSettings only notifies keys read since the handler was connected.
            this._settings.get_value(key);
        }
    }

    _onBarHeightChanged() {
        const height = this._barHeight();
        this.forEachGroup(group => {
            group.view?.setHeight(height);
            group.updateBarHeight();
        });
    }

    _onShowSingleTabChanged() {
        const minTabs = this.minTabs;
        this.forEachGroup(group => group.setMinTabs(minTabs));
    }

    _barHeight() {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        return this._settings.get_int('tab-bar-height') * scaleFactor;
    }

    // --- Discovery ---

    _connectDisplay() {
        const display = global.display;
        this._displaySignals.push(
            [display, display.connect('window-created', (_d, win) => this._onWindowCreated(win))],
            [display, display.connect('notify::focus-window', () => this._onFocusChanged())],
            [display, display.connect('restacked', () => this._forEachView(view => view.restack()))],
            [display, display.connect('grab-op-begin', (_d, win) => this.groupFor(win)?.onGrabBegin(win))],
            [display, display.connect('grab-op-end', (_d, win) => this.groupFor(win)?.onGrabEnd(win))],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed',
                () => this._forEachView(view => view.reposition()))]);
        for (const signal of ['showing', 'hidden']) {
            this._displaySignals.push([Main.overview,
                Main.overview.connect(signal, () => this._forEachView(view => view.reposition()))]);
        }
    }

    _forEachView(fn) {
        for (const group of this._groups) {
            if (group.view)
                fn(group.view);
        }
    }

    _addKeybindings() {
        for (const [name, dir] of CYCLE_KEYBINDINGS) {
            Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this._cycleFocused(dir));
        }
        Main.wm.addKeybinding(TOGGLE_KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this.toggleFocused());
    }

    /**
     * Detaches the focused window from its group, or attaches it to the group
     * of its app on its workspace even when the app rules do not cover it.
     */
    toggleFocused() {
        const win = global.display.focus_window;
        if (!win)
            return;
        const root = transientRoot(win);
        if (this.groupFor(root))
            this.detachAside(root);
        else
            this.attach(root, {force: true, activate: true});
    }

    _cycleFocused(dir) {
        const win = global.display.focus_window;
        if (win)
            this.groupFor(transientRoot(win))?.cycle(dir);
    }

    _onFocusChanged() {
        const win = global.display.focus_window;
        if (!win)
            return;
        const root = transientRoot(win);
        this.groupFor(root)?.onMemberFocused(root);
    }

    _onWindowCreated(win) {
        this._watch(win);
        const actor = win.get_compositor_private();
        // `first-frame` is not emitted for every Wayland client (e.g. under a
        // headless backend), so the window's own `shown` also counts.
        const handlers = [[win, win.connect('shown', () => this._onFirstFrame(win))]];
        if (actor) {
            handlers.push(
                [actor, actor.connect('first-frame', () => this._onFirstFrame(win))],
                [actor, actor.connect('destroy', () => this._cancelFirstFrame(win))]);
        }
        this._firstFrame.set(win, handlers);
    }

    _onFirstFrame(win) {
        this._cancelFirstFrame(win);
        this._queueReady(win);
    }

    // Wayland app IDs are only reliable once the first frame is shown and the
    // window tracker had an idle to catch up.
    _queueReady(win) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleSources.delete(win);
            this._onWindowReady(win);
            return GLib.SOURCE_REMOVE;
        });
        this._idleSources.set(win, id);
    }

    _onWindowReady(win) {
        if (this._maybeGroup(win, {activate: true}) || !isGroupable(win))
            return;
        // The app ID can still arrive late; give it one more chance.
        const id = win.connect('notify::wm-class', () => {
            this._cancelWmClassWait(win);
            this._maybeGroup(win, {activate: true});
        });
        this._wmClassWaits.set(win, id);
    }

    _maybeGroup(win, {activate}) {
        if (this._detached.has(win) || this.groupFor(win))
            return false;
        if (!this._forced.has(win) && !this._matchesRules(win))
            return false;
        return this.attach(win, {activate}) !== null;
    }

    _matchesRules(win) {
        const candidates = ruleCandidates({
            appId: this._realAppId(win),
            wmClass: win.get_wm_class(),
            wmClassInstance: win.get_wm_class_instance(),
            sandboxedAppId: win.get_sandboxed_app_id(),
        });
        return matchesRules(candidates, this._settings.get_strv('app-rules'));
    }

    /** Desktop app ID, or null for window-backed (unknown) apps. */
    _realAppId(win) {
        const app = this._tracker.get_window_app(win);
        return app && !app.is_window_backed() ? app.get_id() : null;
    }

    _groupAppId(win) {
        const appId = this._realAppId(win);
        if (appId)
            return appId;
        const wmClass = win.get_wm_class();
        return wmClass ? `wm-class:${wmClass.toLowerCase()}` : null;
    }

    _findGroup(appId, workspace) {
        for (const group of this._groups) {
            if (group.appId === appId && group.workspace === workspace)
                return group;
        }
        return null;
    }

    /**
     * Visible windows first, each half in MRU order, so the first member of a
     * group (its active tab) is the most recently used visible one and
     * grouping never hides every window of an app.
     */
    _allWindows() {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        const seen = new Set(windows);
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win && !seen.has(win)) {
                seen.add(win);
                windows.push(win);
            }
        }
        // Array.prototype.sort is stable, so MRU order is kept in each half.
        return windows.sort((a, b) => Number(a.minimized) - Number(b.minimized));
    }

    // --- Per-window bookkeeping ---

    _watch(win) {
        if (!this._watched.has(win))
            this._watched.set(win, win.connect('unmanaged', () => this._forget(win)));
    }

    _forget(win) {
        const id = this._watched.get(win);
        if (id !== undefined)
            win.disconnect(id);
        this._watched.delete(win);
        this._cancelFirstFrame(win);
        this._cancelWmClassWait(win);
        const source = this._idleSources.get(win);
        if (source !== undefined)
            GLib.source_remove(source);
        this._idleSources.delete(win);
        this._detached.delete(win);
        this._forced.delete(win);
    }

    _cancelFirstFrame(win) {
        const handlers = this._firstFrame.get(win);
        if (!handlers)
            return;
        this._firstFrame.delete(win);
        for (const [obj, id] of handlers)
            obj.disconnect(id);
    }

    _cancelWmClassWait(win) {
        const id = this._wmClassWaits.get(win);
        if (id === undefined)
            return;
        this._wmClassWaits.delete(win);
        win.disconnect(id);
    }
}

function isGroupable(win) {
    return win.get_window_type() === Meta.WindowType.NORMAL &&
        !win.get_transient_for() &&
        !win.is_skip_taskbar() &&
        !win.is_on_all_workspaces() &&
        win.get_workspace() !== null;
}

/**
 * Rect `steps` × two bar heights down-right of the group's slot, clipped to
 * the work area, so a window leaving the group does not hide it; null (stay
 * in place) for 0 steps or a group without a slot or view.
 */
function asideRect(group, win, steps) {
    const {slot, view} = group;
    if (steps === 0 || !slot || !view)
        return null;
    return offsetRect(slot, win.get_work_area_current_monitor(), steps * 2 * view.barHeight);
}

function transientRoot(win) {
    let root = win;
    for (let parent = root.get_transient_for(); parent; parent = root.get_transient_for())
        root = parent;
    return root;
}
