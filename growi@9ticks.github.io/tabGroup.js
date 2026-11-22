import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {dissolveLayout, formLayout, resizeLayout} from './layout.js';
import {cycleIndex, mruRemove, mruTouch, rectEquals, rectFromMtk} from './util.js';

// Long enough for the configure round trips of an unmaximize and a move,
// even for a client that is still starting up.
const PLACEMENT_SETTLE_MS = 1500;
// Bounds the re-applies, so a client that insists on its own size can't loop.
const PLACEMENT_RETRIES = 2;
// Coalesces bursts of geometry signals (tiling animations, keyboard moves)
// into one move of the hidden tabs.
const SYNC_DEBOUNCE_MS = 120;
// Hidden tabs made transparent for a drag are shown again at the latest
// after this, even if one of them never reaches the slot.
const REVEAL_TIMEOUT_MS = 1000;

/**
 * Windows of one app on one workspace, stacked like tabs: every member has
 * the same frame rect and stays mapped, and `active` is the one raised on
 * top. Switching only raises a window that is already drawn in place, so it
 * needs no resize, no remap and no repaint. The hidden tabs follow the active
 * window's geometry once it settles; while the user drags or resizes it,
 * they are made transparent instead of being resized on every motion.
 *
 * The group minimizes as a whole: minimizing the active tab minimizes every
 * member, and restoring any member brings the group back with that tab in
 * front.
 *
 * While the group has at least `minTabs` members and a view with a
 * `barHeight`, it is in the tabbed layout: the bar sits above the active
 * window, and where there is no room for it (maximized, tiled, top of the
 * work area) its height is taken out of the window.
 *
 * `owner` is the GroupManager and must provide `minTabs`,
 * `onMemberAdded(group, win)`,
 * `onMemberRemoved(group, win)`, `onGroupEmpty(group)`, `onGroupMoved(group)`
 * and `onMemberMovedAway(group, win)`.
 */
export class TabGroup {
    constructor(owner, appId, workspace) {
        this._owner = owner;
        this.appId = appId;
        this.workspace = workspace;
        /** Tab order. */
        this.windows = [];
        /** Most recently used first. */
        this.mru = [];
        this.active = null;
        this.view = null;
        this.minTabs = owner.minTabs;

        this._signals = new Map();
        /** Members being unmanaged → whether they had focus at that point. */
        this._unmanaging = new Map();
        // Frame of the active window, refreshed on every geometry change so the
        // next tab can take the slot after the active window is gone or hidden.
        this._lastRect = null;
        this._followingWorkspace = false;
        this._destroyed = false;

        this._tabbed = false;
        /** How the active window gave room to the bar: formLayout()'s `carved`. */
        this._carved = null;
        /** Rect the active window was given when it was carved. */
        this._carvedRect = null;
        // Height the layout was formed with, so it is undone with the same one.
        this._layoutBarHeight = 0;
        this._maximizeFixSource = 0;
        this._placementGuard = null;
        this._placementGuardSource = 0;

        /** Whether the whole group is minimized (the user minimized the active tab). */
        this._groupMinimized = false;
        // Set while growi itself minimizes or restores members, so their
        // `notify::minimized` is not mistaken for a user action.
        this._changingMinimize = false;
        /** A user move or resize of the active window is in progress. */
        this._grabbing = false;
        this._syncSource = 0;
        /** Hidden tabs made transparent during a drag → their original opacity. */
        this._concealed = new Map();
        this._revealSource = 0;
    }

    get size() {
        return this.windows.length;
    }

    has(win) {
        return this._signals.has(win);
    }

    /** Frame rect of the active slot, including a move that has not landed yet. */
    get slot() {
        return this._slotRect();
    }

    /**
     * Implements the view contract: `sync()`, `updateTitle(win)`,
     * `reposition()`, `restack()`, `destroy()`.
     */
    setView(view) {
        this.view?.destroy();
        this.view = view;
        this.view?.sync();
    }

    add(win, {activate = false} = {}) {
        if (this.has(win))
            return;
        this._connectWindow(win);
        this.windows.push(win);
        this._owner.onMemberAdded(this, win);

        if (!this.active) {
            this.active = win;
            this.mru = [win];
            this._groupMinimized = win.minimized;
            this._storeRect();
            this.updateLayoutState();
            this.view?.sync();
            return;
        }

        this.mru = [...this.mru, win];
        // Form the layout on the current slot first so a new active tab is
        // placed once, directly in the final rect.
        this.updateLayoutState();
        if (activate) {
            this.switchTo(win);
            return;
        }
        this._tuckBehind(win);
        this.view?.sync();
    }

    /**
     * Makes `win` the visible tab, in the slot of the current active window.
     *
     * @param {Meta.Window} win
     * @param {object} [options]
     * @param {boolean} [options.focus] activate `win`; false when it already has focus
     * @param {number} [options.time] event timestamp for activate()
     */
    switchTo(win, {focus = true, time = global.get_current_time()} = {}) {
        if (!this.has(win))
            return;
        const previous = this.active;
        if (win === previous) {
            if (focus)
                win.activate(time);
            return;
        }

        const rect = this._slotRect();
        // Set before activate() so the focus handler sees a no-op.
        this.active = win;
        this.mru = mruTouch(this.mru, win);
        this._reveal(win);

        // Normally a no-op: hidden tabs already sit in the slot.
        placeWindow(win, rect);
        this._withMinimizeChange(() => showWindow(win));
        if (focus)
            win.activate(time);
        else
            win.raise();
        // Switching to a tab of a minimized group restores the group.
        if (this._groupMinimized)
            this._restoreGroup();

        this._rememberSlot(rect);
        this.view?.sync();
        this.view?.restack();
    }

    cycle(dir) {
        if (this.size < 2)
            return;
        const index = cycleIndex(this.size, this.windows.indexOf(this.active), dir);
        this.switchTo(this.windows[index]);
    }

    /** Called when a member received focus by any route (Alt+Tab, dash, …). */
    onMemberFocused(win) {
        if (win !== this.active)
            this.switchTo(win, {focus: false});
    }

    /**
     * @param {Meta.Window} win
     * @param {object} [options]
     * @param {boolean} [options.release] leave `win` visible (unminimized)
     * @param {boolean} [options.focus] focus the window that becomes visible
     * @param {object|null} [options.rect] frame rect for the released window
     */
    remove(win, {release = false, focus = false, rect = null} = {}) {
        if (!this.has(win))
            return;
        this._reveal(win);
        this._removeMember(win);
        // Promote first so the released window is shown and raised last and
        // stacks above the promoted tab whatever Mutter does on unminimize.
        this._afterRemoval(win, {focus: focus && !release});
        if (release) {
            placeWindow(win, rect);
            showWindow(win);
            if (focus)
                win.activate(global.get_current_time());
        }
    }

    /** Takes over every member of `other`, which ends up empty and destroyed. */
    absorb(other) {
        for (const win of [...other.mru]) {
            other._removeMember(win);
            this.add(win);
        }
        other._afterRemoval(null, {focus: false});
    }

    /**
     * Forms the tabbed layout when the group reaches `minTabs` members and
     * dissolves it when it drops below.
     */
    updateLayoutState() {
        const wanted = this.size >= this.minTabs && this.view?.barHeight > 0;
        if (wanted && !this._tabbed)
            this._formLayout();
        else if (!wanted && this._tabbed)
            this._dissolveLayout();
    }

    /** Forms or dissolves the layout for a new `minTabs`. */
    setMinTabs(minTabs) {
        this.minTabs = minTabs;
        this.updateLayoutState();
        this.view?.reposition();
    }

    /**
     * Fits a formed layout to the view's current `barHeight`: the active
     * window moves once, straight to its rect for the new height.
     */
    updateBarHeight() {
        if (!this._tabbed)
            return;
        const oldBarHeight = this._layoutBarHeight;
        this._layoutBarHeight = this.view.barHeight;
        const win = this.active;
        const frame = this._slotRect();
        if (!win || !frame || oldBarHeight === this._layoutBarHeight)
            return;
        const {content, carved} = resizeLayout({
            frame,
            workArea: rectFromMtk(win.get_work_area_current_monitor()),
            oldBarHeight,
            barHeight: this._layoutBarHeight,
            carved: this._carved,
        });
        this._setCarved(carved, content);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this.active && !this._unmanaging.has(this.active))
            this._dissolveLayout();
        this._cancelMaximizeFix();
        this._cancelPlacementGuard();
        this._cancelSync();
        // Never leave a window transparent behind.
        this._revealAll();
        this.view?.destroy();
        this.view = null;
        for (const win of [...this._signals.keys()])
            this._disconnectWindow(win);
        this.windows = [];
        this.mru = [];
        this.active = null;
    }

    _removeMember(win) {
        // An unmanaged window's actor is gone: only drop the reference.
        this._concealed.delete(win);
        this._disconnectWindow(win);
        this.windows = this.windows.filter(w => w !== win);
        this.mru = mruRemove(this.mru, win);
        this._owner.onMemberRemoved(this, win);
    }

    _afterRemoval(removed, {focus}) {
        if (this.size === 0) {
            this.active = null;
            this._owner.onGroupEmpty(this);
            return;
        }
        if (removed !== null && removed === this.active) {
            this.active = null;
            this._promote(this.mru[0], {focus});
            return;
        }
        this.updateLayoutState();
        this.view?.sync();
    }

    /**
     * Brings `win` to the front after the active window went away. It is
     * normally already in the slot, right behind; in a minimized group it
     * stays minimized.
     */
    _promote(win, {focus}) {
        this.active = win;
        this.mru = mruTouch(this.mru, win);
        this._reveal(win);
        placeWindow(win, this._lastRect);
        this._rememberSlot(this._lastRect);
        this.updateLayoutState();
        if (!this._groupMinimized) {
            this._withMinimizeChange(() => showWindow(win));
            if (focus)
                win.activate(global.get_current_time());
            else
                win.raise();
        }
        this.view?.sync();
        this.view?.restack();
    }

    /** Puts a non-active member in the slot right behind the stack, or minimizes it with the group. */
    _tuckBehind(win) {
        if (this._groupMinimized) {
            this._withMinimizeChange(() => hideWindow(win));
            return;
        }
        // Before showWindow(): a just-unminimized Wayland window ignores moves.
        placeWindow(win, this._slotRect());
        this._withMinimizeChange(() => showWindow(win));
        win.lower();
        // A hidden tab never keeps the keyboard: the front tab takes it.
        if (win.has_focus() && this.active !== win && !this.active.minimized)
            this.active.activate(global.get_current_time());
    }

    _withMinimizeChange(fn) {
        const previous = this._changingMinimize;
        this._changingMinimize = true;
        try {
            fn();
        } finally {
            this._changingMinimize = previous;
        }
    }

    /** The user minimized the active tab: the whole group goes with it. */
    _minimizeGroup() {
        this._groupMinimized = true;
        this._cancelSync();
        this._withMinimizeChange(() => {
            for (const member of this.windows) {
                if (member !== this.active)
                    hideWindow(member);
            }
        });
    }

    /** Brings every hidden tab back behind the (now visible) active one. */
    _restoreGroup() {
        this._groupMinimized = false;
        for (const member of this.windows) {
            if (member !== this.active && member.minimized)
                this._tuckBehind(member);
        }
    }

    _onMinimizedChanged(win) {
        if (this._changingMinimize) {
            this.view?.reposition();
            return;
        }
        if (win === this.active) {
            if (win.minimized && !this._groupMinimized)
                this._minimizeGroup();
            else if (!win.minimized && this._groupMinimized)
                this._restoreGroup();
        } else if (!win.minimized && this._groupMinimized) {
            // A hidden tab restored from the dash or Alt+Tab comes back in front.
            this.switchTo(win, {focus: false});
        }
        this.view?.reposition();
    }

    // Moves every visible hidden tab into the slot once the active window's
    // geometry stopped changing. Never during a user drag.
    _queueSync() {
        if (this._grabbing || this._groupMinimized)
            return;
        this._cancelSync();
        this._syncSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DEBOUNCE_MS, () => {
            this._syncSource = 0;
            this._syncHidden();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSync() {
        if (this._syncSource)
            GLib.source_remove(this._syncSource);
        this._syncSource = 0;
    }

    _syncHidden() {
        const rect = this._slotRect();
        if (!rect || this._grabbing)
            return;
        for (const member of this.windows) {
            if (member === this.active || member.minimized)
                continue;
            if (rectEquals(rectFromMtk(member.get_frame_rect()), rect))
                this._reveal(member);
            else
                placeWindow(member, rect);
        }
    }

    // During a drag the hidden tabs would show behind the moving window:
    // make them transparent (compositor side only, the client never notices)
    // until they are back in the slot.
    _conceal() {
        for (const member of this.windows) {
            const actor = member.get_compositor_private();
            if (member === this.active || member.minimized || !actor || this._concealed.has(member))
                continue;
            this._concealed.set(member, actor.opacity);
            actor.opacity = 0;
        }
    }

    _reveal(win) {
        if (!this._concealed.has(win))
            return;
        const opacity = this._concealed.get(win);
        this._concealed.delete(win);
        const actor = win.get_compositor_private();
        if (actor)
            actor.opacity = opacity;
        if (this._concealed.size === 0)
            this._cancelReveal();
    }

    _revealAll() {
        for (const win of [...this._concealed.keys()])
            this._reveal(win);
        this._cancelReveal();
    }

    _revealLater() {
        this._cancelReveal();
        if (this._concealed.size === 0)
            return;
        this._revealSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_TIMEOUT_MS, () => {
            this._revealSource = 0;
            this._revealAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelReveal() {
        if (this._revealSource)
            GLib.source_remove(this._revealSource);
        this._revealSource = 0;
    }

    /** A hidden tab moved: show it again once it is back in the slot. */
    _onHiddenGeometryChanged(win) {
        if (this._concealed.has(win) && !this._grabbing &&
            rectEquals(rectFromMtk(win.get_frame_rect()), this._slotRect()))
            this._reveal(win);
    }

    // The last requested or reported rect of the active window: its frame can
    // lag behind a move that has not landed yet.
    _slotRect() {
        if (this._lastRect)
            return this._lastRect;
        if (this.active && !this.active.minimized)
            return rectFromMtk(this.active.get_frame_rect());
        return null;
    }

    _formLayout() {
        this._tabbed = true;
        this._layoutBarHeight = this.view.barHeight;
        const win = this.active;
        const frame = this._slotRect();
        if (!win || !frame)
            return;
        const {content, carved} = formLayout({
            frame,
            workArea: rectFromMtk(win.get_work_area_current_monitor()),
            barHeight: this._layoutBarHeight,
            maximizeFlags: win.get_maximize_flags(),
        });
        this._setCarved(carved, content);
    }

    _dissolveLayout() {
        this._tabbed = false;
        this._cancelMaximizeFix();
        this._cancelPlacementGuard();
        const win = this.active;
        const frame = this._slotRect();
        const carved = this._carved;
        this._carved = null;
        this._carvedRect = null;
        if (!carved || !win || !frame)
            return;
        const {action, rect} = dissolveLayout({
            frame,
            workArea: rectFromMtk(win.get_work_area_current_monitor()),
            barHeight: this._layoutBarHeight,
            carved,
        });
        if (action === 'extend')
            this._placeActive(rect);
        else if (action === 'maximize')
            win.maximize();
    }

    _placeActive(rect) {
        const win = this.active;
        const unmaximizing = !win.minimized && win.get_maximize_flags() !== 0;
        placeWindow(win, rect);
        this._rememberSlot(rect);
        if (unmaximizing)
            this._guardPlacement(win, rect);
    }

    // Unmaximizing a visible window races with the move that follows: the
    // client can settle at Mutter's unmaximized size instead, before or after
    // the requested rect. Until the placement settles, a frame that lands
    // elsewhere gets the rect re-applied, a bounded number of times.
    _guardPlacement(win, rect) {
        this._cancelPlacementGuard();
        this._placementGuard = {win, rect, retries: PLACEMENT_RETRIES};
        this._placementGuardSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACEMENT_SETTLE_MS, () => {
            this._placementGuardSource = 0;
            this._placementGuard = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _enforcePlacement(win) {
        const guard = this._placementGuard;
        if (!guard || guard.win !== win || guard.retries === 0 || win.minimized || win.get_maximize_flags())
            return;
        const {rect} = guard;
        if (rectEquals(rectFromMtk(win.get_frame_rect()), rect))
            return;
        guard.retries--;
        win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    }

    _cancelPlacementGuard() {
        if (this._placementGuardSource)
            GLib.source_remove(this._placementGuardSource);
        this._placementGuardSource = 0;
        this._placementGuard = null;
    }

    // A window maximized or tiled while tabbed is given back its rect minus
    // the bar, once: after the unmaximize its flags are 0, so the resulting
    // geometry signals do not queue another fix.
    _queueMaximizeFix() {
        if (this._maximizeFixSource)
            return;
        this._maximizeFixSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._maximizeFixSource = 0;
            this._fitMaximized();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelMaximizeFix() {
        if (this._maximizeFixSource)
            GLib.source_remove(this._maximizeFixSource);
        this._maximizeFixSource = 0;
    }

    _fitMaximized() {
        const win = this.active;
        if (!this._tabbed || !win || !win.get_maximize_flags())
            return;
        // Re-read here: the tile rect is only known once the maximize landed.
        const {content, carved} = formLayout({
            frame: rectFromMtk(win.get_frame_rect()),
            workArea: rectFromMtk(win.get_work_area_current_monitor()),
            barHeight: this._layoutBarHeight,
            maximizeFlags: win.get_maximize_flags(),
        });
        this._setCarved(carved, content);
    }

    /** A user move or resize of `win` starts: never fight it. */
    onGrabBegin(win) {
        if (win !== this.active)
            return;
        this._grabbing = true;
        this._cancelPlacementGuard();
        this._cancelSync();
        this._cancelReveal();
        this._conceal();
    }

    /**
     * Called when a user move or resize of `win` ends. The geometry is now
     * the user's choice: a window pushed against the top of the work area
     * gives the bar's height again so the bar does not end up under the
     * panel, and any other one is no longer re-maximized on dissolve.
     */
    onGrabEnd(win) {
        if (win !== this.active)
            return;
        this._grabbing = false;
        this._fitAfterGrab(win);
        // The hidden tabs catch up with the final geometry and reappear as
        // they land in the slot.
        this._queueSync();
        this._revealLater();
    }

    _fitAfterGrab(win) {
        if (!this._tabbed || win.minimized || win.get_maximize_flags() || win.is_fullscreen())
            return;
        const frame = rectFromMtk(win.get_frame_rect());
        // A click on a client-side title bar is a grab that moves nothing.
        if (this._carved && rectEquals(frame, this._carvedRect))
            return;
        this._storeRect();
        const {content, carved} = formLayout({
            frame,
            workArea: rectFromMtk(win.get_work_area_current_monitor()),
            barHeight: this._layoutBarHeight,
            maximizeFlags: 0,
        });
        this._setCarved(carved, content);
    }

    _setCarved(carved, content) {
        this._carved = carved;
        this._carvedRect = carved ? content : null;
        if (carved)
            this._placeActive(content);
    }

    // A move of a visible Wayland window lands asynchronously, so the
    // requested rect is kept until the next geometry signal replaces it.
    _rememberSlot(rect) {
        if (rect)
            this._lastRect = rect;
        else
            this._storeRect();
    }

    // A fullscreen frame is never the slot: the next tab would cover the
    // monitor and the panel.
    _storeRect() {
        if (this.active && !this.active.minimized && !this.active.is_fullscreen())
            this._lastRect = rectFromMtk(this.active.get_frame_rect());
    }

    _connectWindow(win) {
        const ids = [
            win.connect('unmanaging', () => this._onUnmanaging(win)),
            win.connect('unmanaged', () => this._onUnmanaged(win)),
            win.connect('notify::title', () => this.view?.updateTitle(win)),
            win.connect('notify::minimized', () => this._onMinimizedChanged(win)),
            win.connect('notify::fullscreen', () => this._onGeometryChanged(win)),
            win.connect('position-changed', () => this._onGeometryChanged(win)),
            win.connect('size-changed', () => this._onGeometryChanged(win)),
            win.connect('workspace-changed', () => this._onWorkspaceChanged(win)),
        ];
        this._signals.set(win, ids);
    }

    _disconnectWindow(win) {
        for (const id of this._signals.get(win) ?? [])
            win.disconnect(id);
        this._signals.delete(win);
        this._unmanaging.delete(win);
    }

    _onUnmanaging(win) {
        // Focus has already moved on by the time `unmanaged` fires.
        this._unmanaging.set(win, win.has_focus());
    }

    _onUnmanaged(win) {
        const hadFocus = this._unmanaging.get(win) ?? false;
        // The window is gone: only drop references, never call into it.
        this._removeMember(win);
        this._afterRemoval(win, {focus: hadFocus});
    }

    _onGeometryChanged(win) {
        if (win !== this.active) {
            this._onHiddenGeometryChanged(win);
            return;
        }
        this._storeRect();
        this._enforcePlacement(win);
        if (this._tabbed && win.get_maximize_flags())
            this._queueMaximizeFix();
        else
            this._queueSync();
        this.view?.reposition();
    }

    _onWorkspaceChanged(win) {
        // An unmanaging window leaves its workspace too; `unmanaged` handles it.
        if (this._followingWorkspace || this._unmanaging.has(win))
            return;
        const workspace = win.get_workspace();
        // A window made sticky keeps reporting its current workspace.
        const leftWorkspaces = !workspace || win.is_on_all_workspaces();
        if (!leftWorkspaces && workspace === this.workspace)
            return;

        if (leftWorkspaces || win !== this.active) {
            this._owner.onMemberMovedAway(this, win);
            return;
        }

        this._followingWorkspace = true;
        try {
            for (const member of this.windows) {
                if (member !== win)
                    member.change_workspace(workspace);
            }
        } finally {
            this._followingWorkspace = false;
        }
        this.workspace = workspace;
        this.view?.reposition();
        this._owner.onGroupMoved(this);
    }
}

/** Unminimizes without the effect; only skips when the state really changes. */
export function showWindow(win) {
    if (!win.minimized)
        return;
    skipEffect(win);
    win.unminimize();
}

function hideWindow(win) {
    if (win.minimized)
        return;
    skipEffect(win);
    win.minimize();
}

function skipEffect(win) {
    const actor = win.get_compositor_private();
    if (actor)
        Main.wm.skipNextEffect(actor);
}

// Call before showWindow(): a Wayland window that was just unminimized
// ignores the request, while a still-minimized one takes it immediately.
function placeWindow(win, rect) {
    if (!rect)
        return;
    if (win.get_maximize_flags())
        win.unmaximize();
    if (!rectEquals(rectFromMtk(win.get_frame_rect()), rect))
        win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
}
