import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {shortenTitle} from './layout.js';

const ICON_SIZE = 16;
// Smooth scroll deltas are in discrete-notch units; one notch cycles one tab.
const SMOOTH_SCROLL_STEP = 1;

/**
 * Tab bar view of a TabGroup: one tab per window, drawn in
 * `global.window_group` right above the active window's frame and stacked
 * just above its actor. Implements the TabGroup view contract.
 */
class GrowiTabBar extends St.BoxLayout {
    /**
     * @param {TabGroup} group
     * @param {GroupManager} manager
     * @param {number} height bar height in stage pixels
     */
    _init(group, manager, height) {
        super._init({
            style_class: 'growi-tabbar',
            reactive: true,
            visible: false,
        });
        this.layout_manager.homogeneous = true;
        this._group = group;
        this._manager = manager;
        this._height = height;
        this._tabs = new Map();
        this._scrollDelta = 0;
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
        global.window_group.add_child(this);
    }

    get barHeight() {
        return this._height;
    }

    /** @param {number} height bar height in stage pixels */
    setHeight(height) {
        this._height = height;
        this.reposition();
    }

    sync() {
        const windows = this._group.windows;
        for (const [win, tab] of this._tabs) {
            if (!windows.includes(win)) {
                this._tabs.delete(win);
                tab.destroy();
            }
        }
        windows.forEach((win, index) => {
            let tab = this._tabs.get(win);
            if (!tab) {
                tab = new Tab(win, (button, time) => this._onTabClicked(win, button, time));
                this._tabs.set(win, tab);
                this.insert_child_at_index(tab, index);
            } else if (this.get_child_at_index(index) !== tab) {
                this.set_child_at_index(tab, index);
            }
            tab.setActive(win === this._group.active);
        });
        this.reposition();
        this.restack();
    }

    updateTitle(win) {
        this._tabs.get(win)?.updateTitle();
    }

    // Runs on every position-changed during drags: geometry only, no relayout
    // of the tabs.
    reposition() {
        const win = this._group.active;
        if (!this._shouldShow(win)) {
            this.hide();
            return;
        }
        const frame = win.get_frame_rect();
        this.set_position(frame.x, frame.y - this._height);
        this.set_size(frame.width, this._height);
        this.show();
    }

    restack() {
        const actor = this._group.active?.get_compositor_private();
        // Window actors can be reparented during workspace animations.
        if (actor && actor.get_parent() === this.get_parent())
            this.get_parent().set_child_above_sibling(this, actor);
    }

    _shouldShow(win) {
        return win !== null &&
            this._group.size >= this._group.minTabs &&
            !win.minimized &&
            !win.is_fullscreen() &&
            win.get_workspace() === global.workspace_manager.get_active_workspace() &&
            !Main.overview.visible;
    }

    _onTabClicked(win, button, time) {
        switch (button) {
            case Clutter.BUTTON_PRIMARY:
                this._group.switchTo(win, {time});
                break;
            case Clutter.BUTTON_MIDDLE:
                win.delete(time);
                break;
            case Clutter.BUTTON_SECONDARY:
                this._manager.detachAside(win);
                break;
        }
    }

    _onScroll(event) {
        // A wheel notch arrives both as a discrete and as a smooth event; one
        // of the two is flagged as emulated.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const dir = this._scrollDirection(event);
        if (dir !== 0)
            this._group.cycle(dir);
        return Clutter.EVENT_STOP;
    }

    _scrollDirection(event) {
        switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                return -1;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                return 1;
            case Clutter.ScrollDirection.SMOOTH: {
                const [dx, dy] = event.get_scroll_delta();
                this._scrollDelta += Math.abs(dy) >= Math.abs(dx) ? dy : dx;
                if (Math.abs(this._scrollDelta) < SMOOTH_SCROLL_STEP)
                    return 0;
                const dir = Math.sign(this._scrollDelta);
                this._scrollDelta = 0;
                return dir;
            }
            default:
                return 0;
        }
    }
}

export const TabBar = GObject.registerClass(GrowiTabBar);

/** One tab: app icon, short title and a close button. */
class GrowiTab extends St.Button {
    /**
     * @param {Meta.Window} win
     * @param {function(number, number): void} onClicked called with the
     *   mouse button and event time
     */
    _init(win, onClicked) {
        super._init({
            style_class: 'growi-tab',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            x_expand: true,
            track_hover: true,
            can_focus: false,
        });
        this._win = win;
        this._app = Shell.WindowTracker.get_default().get_window_app(win);

        this._label = new St.Label({
            style_class: 'growi-tab-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // The inner button stops the press, so × never also switches tabs.
        const close = new St.Button({
            style_class: 'growi-tab-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: false,
        });
        close.connect('clicked', () => win.delete(global.get_current_time()));

        const box = new St.BoxLayout({x_expand: true});
        const icon = this._app?.create_icon_texture(ICON_SIZE);
        if (icon) {
            icon.y_align = Clutter.ActorAlign.CENTER;
            box.add_child(icon);
        }
        box.add_child(this._label);
        box.add_child(close);
        this.set_child(box);

        this.connect('clicked', (_tab, button) => onClicked(button, global.get_current_time()));
        this.updateTitle();
    }

    updateTitle() {
        this._label.text = shortenTitle(this._win.get_title(), this._app?.get_name() ?? null);
    }

    setActive(active) {
        if (active)
            this.add_style_class_name('growi-tab-active');
        else
            this.remove_style_class_name('growi-tab-active');
    }
}

const Tab = GObject.registerClass(GrowiTab);
