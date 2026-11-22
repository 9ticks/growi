#!/usr/bin/env bash
# Headless end-to-end smoke test for growi@9ticks.github.io.
#
# Boots a nested `gnome-shell --headless` on a private D-Bus session with
# isolated XDG dirs and a keyfile GSettings backend, so the user's real dconf
# database, extensions and session are never touched. Assertions run through
# org.gnome.Shell.Eval, unlocked by the test-only tools/smoke-helper@local.
#
# Usage: tools/smoke.sh            (expects growi@9ticks.github.io.shell-extension.zip; `make smoke` builds it)
# Env:   SMOKE_KEEP=1 keeps the temp dir for debugging.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=growi@9ticks.github.io
HELPER=smoke-helper@local
ZIP="$ROOT/$UUID.shell-extension.zip"
DISPLAY_NAME=growi-smoke-$$

if [[ -z "${GROWI_SMOKE_INNER:-}" ]]; then
    [[ -f "$ZIP" ]] || { echo "smoke: $ZIP missing, run 'make pack' first" >&2; exit 2; }
    base=${TMPDIR:-/tmp}
    TMP=$(mktemp -d "$base/growi-smoke.XXXXXX")
    cleanup_outer() {
        # A GTK client may have started xdg-document-portal's FUSE mount.
        if mountpoint -q "$TMP/runtime/doc" 2>/dev/null; then
            fusermount3 -u "$TMP/runtime/doc" 2>/dev/null || fusermount -u "$TMP/runtime/doc" 2>/dev/null || true
        fi
        if [[ -n "${SMOKE_KEEP:-}" ]]; then
            echo "smoke: kept $TMP"
        else
            rm -rf "$TMP"
        fi
    }
    trap cleanup_outer EXIT
    trap 'exit 130' INT TERM
    mkdir -p "$TMP"/{home,config,data,cache,state,runtime}
    chmod 700 "$TMP/runtime"

    # Everything below runs with isolated XDG dirs on a private session bus.
    env -i \
        HOME="$TMP/home" PATH="$PATH" USER="${USER:-}" LANG="${LANG:-C.UTF-8}" \
        XDG_CONFIG_HOME="$TMP/config" XDG_DATA_HOME="$TMP/data" \
        XDG_CACHE_HOME="$TMP/cache" XDG_STATE_HOME="$TMP/state" \
        XDG_RUNTIME_DIR="$TMP/runtime" \
        GSETTINGS_BACKEND=keyfile \
        GROWI_SMOKE_INNER=1 GROWI_SMOKE_TMP="$TMP" \
        dbus-run-session -- "$0" "$@"
    exit $?
fi

# ---------------------------------------------------------------- inner part
TMP=$GROWI_SMOKE_TMP
LOG="$TMP/gnome-shell.log"
EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions"
SHELL_PID=
CLIENT_PIDS=()

cleanup_inner() {
    for pid in "${CLIENT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    if [[ -n "$SHELL_PID" ]]; then
        kill "$SHELL_PID" 2>/dev/null || true
        wait "$SHELL_PID" 2>/dev/null || true
    fi
}
trap cleanup_inner EXIT
trap 'exit 130' INT TERM

fail() {
    echo "FAIL: $*"
    echo "--- gnome-shell log (growi/JS errors) ---"
    grep -iE 'growi|JS ERROR|smoke-helper' "$LOG" | tail -40 || true
    exit 1
}

install_extensions() {
    mkdir -p "$EXT_DIR/$UUID"
    (cd "$EXT_DIR/$UUID" && unzip -q "$ROOT/$(basename "$ZIP")")
    glib-compile-schemas --strict "$EXT_DIR/$UUID/schemas"
    cp -r "$ROOT/tools/$HELPER" "$EXT_DIR/$HELPER"
}

growi_gsettings() {
    gsettings --schemadir "$EXT_DIR/$UUID/schemas" "$1" org.gnome.shell.extensions.growi "${@:2}"
}

configure_settings() {
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "['$HELPER', '$UUID']"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
    growi_gsettings set app-rules "['org.gnome.TextEditor.desktop']"
}

# Evaluates JS in the nested shell; prints the JSON result or fails.
shell_eval() {
    local out
    out=$(gdbus call --session --timeout 20 --dest org.gnome.Shell \
        --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1) || return 1
    [[ "$out" == "(true, "* ]] || { echo "$out" >&2; return 1; }
    # (true, '<json>') → <json>
    out=${out#"(true, '"}
    echo "${out%"')"}"
}

wait_for_shell() {
    for _ in $(seq 1 120); do
        kill -0 "$SHELL_PID" 2>/dev/null || fail "gnome-shell exited early"
        if [[ $(shell_eval '!!Main.extensionManager.lookup("growi@9ticks.github.io")?.stateObj?._manager' 2>/dev/null) == true ]]; then
            return 0
        fi
        sleep 0.5
    done
    fail "nested shell or growi@9ticks.github.io did not come up"
}

# Polls a JS boolean expression until it is true.
wait_until() {
    local expr=$1 what=$2
    for _ in $(seq 1 60); do
        [[ $(shell_eval "$expr" 2>/dev/null) == true ]] && return 0
        sleep 0.25
    done
    fail "timed out waiting for: $what"
}

check() {
    local expr=$1 what=$2
    [[ $(shell_eval "$expr") == true ]] || fail "$what"
    echo "PASS: $what"
}

launch_client() {
    WAYLAND_DISPLAY=$DISPLAY_NAME GDK_BACKEND=wayland GDK_DEBUG=no-portals GTK_USE_PORTAL=0 "$@" >>"$TMP/clients.log" 2>&1 &
    CLIENT_PIDS+=($!)
}

# Presses then releases Clutter keyvals (e.g. KEY_Super_L) on a virtual keyboard.
press_keys() {
    local keys
    keys=$(printf 'Clutter.%s,' "$@")
    shell_eval "$(js "const kbd = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const t = () => GLib.get_monotonic_time(); const keys = [${keys%,}];
    for (const k of keys) kbd.notify_keyval(t(), k, Clutter.KeyState.PRESSED);
    for (const k of keys.reverse()) kbd.notify_keyval(t(), k, Clutter.KeyState.RELEASED);
    return true;")" >/dev/null
}

# JS prelude shared by every assertion.
JS_PRE='const M = Main.extensionManager.lookup("growi@9ticks.github.io").stateObj._manager;
const eds = () => global.get_window_actors().map(a => a.meta_window)
    .filter(w => w.get_wm_class() === "org.gnome.TextEditor");
const groups = () => { const r = []; M.forEachGroup(g => r.push(g)); return r; };
const rect = w => { const f = w.get_frame_rect(); return [f.x, f.y, f.width, f.height].join(","); };
// Stack mode: no tab is minimized and the active one is on top of its group.
const stacked = g => !g.windows.some(w => w.minimized) &&
    global.display.sort_windows_by_stacking(g.windows).at(-1) === g.active;
const VIEW_HOOKS = ["sync", "updateTitle", "reposition", "restack"];
const barOnActive = g => { const f = g.active.get_frame_rect(); const b = g.view;
    return b.visible && b.x === f.x && b.y + b.height === f.y && b.width === f.width; };
const ptr = () => (globalThis.smokePtr ??= Clutter.get_default_backend().get_default_seat()
    .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE));
const calcWin = () => global.get_window_actors().map(a => a.meta_window).find(w => w.get_wm_class() === "org.gnome.Calculator");
const apart = ws => new Set(ws.map(rect)).size === ws.length;
const opaque = ws => ws.every(w => w.get_compositor_private().opacity === 255);
const bars = () => global.window_group.get_children().filter(a => a.has_style_class_name?.("growi-tabbar"));'

js() { echo "(() => { const Clutter = imports.gi.Clutter; $JS_PRE $1 })()"; }

# Moves the virtual pointer onto a fraction of an actor's width (until it is
# really there), then presses and releases a mouse button.
click() {
    local actor=$1 button=$2 fx=${3:-0.33}
    shell_eval "$(js "const a = $actor; const [x, y] = a.get_transformed_position(); const [w, h] = a.get_transformed_size();
        smoke.px = Math.round(x + w * $fx); smoke.py = Math.round(y + h / 2); return true;")" >/dev/null
    wait_until "$(js 'const [x, y] = global.get_pointer(); if (x === smoke.px && y === smoke.py) return true;
        ptr().notify_absolute_motion(GLib.get_monotonic_time(), smoke.px, smoke.py); return false;')" "pointer on target"
    shell_eval "$(js "const t = GLib.get_monotonic_time();
        ptr().notify_button(t, $button, Clutter.ButtonState.PRESSED);
        ptr().notify_button(t + 1000, $button, Clutter.ButtonState.RELEASED); return true;")" >/dev/null
}

# One wheel notch down over an actor.
scroll_bar() {
    local actor=$1
    shell_eval "$(js "const a = $actor; const [x, y] = a.get_transformed_position();
        smoke.px = Math.round(x + 20); smoke.py = Math.round(y + a.height / 2); return true;")" >/dev/null
    wait_until "$(js 'const [x, y] = global.get_pointer(); if (x === smoke.px && y === smoke.py) return true;
        ptr().notify_absolute_motion(GLib.get_monotonic_time(), smoke.px, smoke.py); return false;')" "pointer on bar"
    shell_eval "$(js 'ptr().notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.DOWN,
        Clutter.ScrollSource.WHEEL); return true;')" >/dev/null
}

install_extensions
configure_settings

gnome-shell --headless --no-x11 --virtual-monitor 1600x1000 \
    --wayland-display "$DISPLAY_NAME" >"$LOG" 2>&1 &
SHELL_PID=$!
wait_for_shell
echo "PASS: nested shell up, growi@9ticks.github.io enabled"
# The shell starts in the overview, where NORMAL-mode keybindings are inactive.
shell_eval 'Main.overview.hide(); true' >/dev/null
wait_until '!Main.overview.visible && !Main.overview.animationInProgress' "overview hidden"

# 1. Grouping: two editor windows → one group of two; another app is ignored.
launch_client gnome-text-editor --new-window
wait_until "$(js 'return eds().length === 1 && groups().length === 1;')" "first editor window grouped"
launch_client gnome-text-editor --new-window
wait_until "$(js 'return eds().length === 2 && groups().length === 1 && groups()[0].size === 2;')" "second editor window"
launch_client gnome-calculator
wait_until "$(js 'return global.get_window_actors().some(a => a.meta_window.get_wm_class() === "org.gnome.Calculator");')" "calculator window"
sleep 1
check "$(js 'const calc = global.get_window_actors().map(a => a.meta_window).find(w => w.get_wm_class() === "org.gnome.Calculator");
    return groups().length === 1 && M.groupFor(calc) === null;')" "other app's window is not grouped"
check "$(js 'return stacked(groups()[0]);')" \
    "no tab minimized, the active one stacked on top"
check "$(js 'const g = groups()[0]; return g.active === g.windows[1];')" "newest window is the active tab"
wait_until "$(js 'const g = groups()[0]; return rect(g.windows[1]) === rect(g.windows[0]);')" "new window takes the previous slot"
echo "PASS: the new window is placed at the previous active window's frame rect"

# 2. Focus-driven switch: activating the hidden window swaps visibility and keeps the slot.
shell_eval "$(js 'const g = groups()[0]; const hidden = g.windows.find(w => w !== g.active);
    globalThis.smoke = {prev: g.active, target: hidden, rect: rect(g.active)};
    hidden.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'const g = groups()[0]; return g.active === smoke.target && stacked(g);')" \
    "activate() switches tabs"
wait_until "$(js 'return rect(smoke.target) === smoke.rect;')" "switched tab takes the previous frame rect"
echo "PASS: activating a hidden member switches tabs and keeps the frame rect"

# 3. Keybinding: Super+Alt+Page_Down via a virtual keyboard cycles to the other tab.
check "$(js 'return Main.wm._allowedKeybindings["next-tab"] === Shell.ActionMode.NORMAL &&
    Main.wm._allowedKeybindings["previous-tab"] === Shell.ActionMode.NORMAL;')" "next-tab/previous-tab registered"
press_keys KEY_Super_L KEY_Alt_L KEY_Page_Down
wait_until "$(js 'const g = groups()[0]; return g.active === smoke.prev && stacked(g);')" \
    "Super+Alt+Page_Down cycles tabs"
echo "PASS: Super+Alt+Page_Down cycles tabs"
check "$(js 'const g = groups()[0]; return Main.wm._skippedActors.size === 0 && g.windows.every(w => w.get_compositor_private().opacity === 255);')" \
    "no pending skipped effect, no tab left transparent"

# View contract: the bar sees sync/restack on switches, reposition on geometry changes.
shell_eval "$(js 'const g = groups()[0]; const bar = g.view; smoke.calls = [];
    for (const name of VIEW_HOOKS) {
        const orig = bar[name].bind(bar);
        bar[name] = (...args) => { smoke.calls.push(name); return orig(...args); };
    }
    g.cycle(1); g.cycle(1);
    const f = g.active.get_frame_rect(); g.active.move_frame(true, f.x + 10, f.y + 10); return true;')" >/dev/null
wait_until "$(js 'return smoke.calls.includes("reposition");')" "view reposition() on geometry change"
check "$(js 'const g = groups()[0]; const c = smoke.calls; for (const name of VIEW_HOOKS) delete g.view[name];
    return c.filter(x => x === "sync").length >= 2 && c.filter(x => x === "restack").length >= 2;')" \
    "view hook receives sync/restack/reposition"

# cycle() raises a hidden tab that already sits in the moved slot.
shell_eval "$(js 'const g = groups()[0]; smoke.rect = rect(g.active); smoke.prev = g.active; g.cycle(1); return true;')" >/dev/null
wait_until "$(js 'const g = groups()[0]; return g.active !== smoke.prev && rect(g.active) === smoke.rect && rect(smoke.prev) === smoke.rect && stacked(g);')" \
    "cycle() places the hidden tab in the active slot"
echo "PASS: cycle() places the hidden tab in the active slot"

# 4. Workspace follow, regroup of a hidden member, and merge.
shell_eval "$(js 'const g = groups()[0]; smoke.mover = g.active; smoke.other = g.windows.find(w => w !== g.active);
    smoke.mover.change_workspace_by_index(1, false); return true;')" >/dev/null
wait_until "$(js 'const g = groups()[0]; return groups().length === 1 && g.workspace.index() === 1 &&
    g.windows.every(w => w.get_workspace().index() === 1);')" "group follows its active window to workspace 2"
echo "PASS: moving the active window moves the whole group"
shell_eval "$(js 'smoke.other.change_workspace_by_index(0, false); return true;')" >/dev/null
wait_until "$(js 'return groups().length === 2 && M.groupFor(smoke.other).workspace.index() === 0 &&
    M.groupFor(smoke.mover).size === 1;')" "hidden member moved alone is regrouped"
echo "PASS: a hidden member moved on its own is regrouped on its new workspace"
shell_eval "$(js 'smoke.mover.change_workspace_by_index(0, false); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.mover); return groups().length === 1 && g.size === 2 &&
    g.active === smoke.mover && stacked(g);')" "same-app groups merge"
echo "PASS: same-app groups meeting on one workspace merge"

# 5. Closing the focused active window brings the other back in the same slot, focused.
shell_eval "$(js 'smoke.mover.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.display.focus_window === smoke.mover;')" "active tab focused"
shell_eval "$(js 'const g = groups()[0]; smoke.rect = rect(g.active); smoke.other = g.windows.find(w => w !== g.active);
    g.active.delete(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'const g = groups()[0]; return g !== undefined && g.size === 1 && g.active === smoke.other && !smoke.other.minimized;')" \
    "closing the active window promotes the other"
wait_until "$(js 'return rect(smoke.other) === smoke.rect;')" "promoted tab takes the closed window's rect"
wait_until "$(js 'return global.display.focus_window === smoke.other;')" "promoted tab gets focus"
echo "PASS: closing the active window brings the remaining one to the front at the same rect"

# 6. Detaching the active tab leaves it visible, focused and above the promoted tab.
launch_client gnome-text-editor --new-window
wait_until "$(js 'return eds().length === 2 && groups().length === 1 && groups()[0].size === 2;')" "third editor window grouped"
shell_eval "$(js 'const g = groups()[0]; smoke.det = g.active; smoke.kept = g.windows.find(w => w !== g.active);
    M.detach(smoke.det, {focus: true}); return true;')" >/dev/null
wait_until "$(js 'return !smoke.det.minimized && M.groupFor(smoke.det) === null && global.display.focus_window === smoke.det &&
    M.groupFor(smoke.kept)?.active === smoke.kept && !smoke.kept.minimized;')" "detached window visible, focused and ungrouped"
check "$(js 'const order = global.display.sort_windows_by_stacking([smoke.det, smoke.kept]);
    return order.indexOf(smoke.det) > order.indexOf(smoke.kept);')" "detach leaves the released window above the promoted tab"

# 7. A hidden member that leaves its group without joining another stays visible.
shell_eval "$(js 'M.attach(smoke.det); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.det); return g?.size === 2 && g.active !== smoke.det && stacked(g) && rect(smoke.det) === rect(g.active);')" "detached window re-attached as a hidden tab"
shell_eval "$(js 'smoke.det.stick(); return true;')" >/dev/null
wait_until "$(js 'return M.groupFor(smoke.det) === null && !smoke.det.minimized && M.groupFor(smoke.kept)?.size === 1;')" \
    "sticky hidden member released"
echo "PASS: a hidden member made sticky leaves its group and stays visible"
shell_eval "$(js 'smoke.det.unstick(); M.attach(smoke.det); return true;')" >/dev/null
wait_until "$(js 'return M.groupFor(smoke.det) === M.groupFor(smoke.kept) && M.groupFor(smoke.kept).size === 2 &&
    M.groupFor(smoke.kept).active === smoke.kept && stacked(M.groupFor(smoke.kept));')" "unstuck window re-attached as a hidden tab"

# 8. Re-enabling with a minimized most-recent member keeps the visible one as the active tab.
shell_eval 'Main.extensionManager.disableExtension("growi@9ticks.github.io"); true' >/dev/null
wait_until '!Main.extensionManager.lookup("growi@9ticks.github.io").stateObj._manager' "extension disabled"
shell_eval "$(js 'smoke.det.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.display.focus_window === smoke.det && !smoke.kept.minimized;')" "both editor windows visible"
shell_eval "$(js 'smoke.calc = global.get_window_actors().map(a => a.meta_window).find(w => w.get_wm_class() === "org.gnome.Calculator");
    smoke.calc.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.display.focus_window === smoke.calc;')" "calculator focused"
shell_eval "$(js 'smoke.det.minimize(); return true;')" >/dev/null
# Mutter's tab list already puts minimized windows last; growi sorts them last
# itself too, so only the outcome is asserted here.
wait_until "$(js 'return smoke.det.minimized && !smoke.kept.minimized;')" "most recently used editor minimized, the other visible"
shell_eval 'Main.extensionManager.enableExtension("growi@9ticks.github.io"); true' >/dev/null
wait_until '!!Main.extensionManager.lookup("growi@9ticks.github.io").stateObj._manager' "extension re-enabled"
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g?.size === 2 && g.active === smoke.kept && stacked(g);')" \
    "visible window stays the active tab after re-enable, the minimized one restored behind it"
echo "PASS: enabling mid-session keeps a visible window as the active tab"

# 9. Tab bar: one tab per window in tab order, active highlighted, short titles.
check "$(js 'const g = M.groupFor(smoke.kept); const tabs = g.view.get_children();
    return bars().length === 1 && bars()[0] === g.view && tabs.length === 2 &&
        tabs.every((t, i) => t.has_style_class_name("growi-tab-active") === (g.windows[i] === g.active)) &&
        tabs.every((t, i) => t.get_child().get_children().some(c => c.text && g.windows[i].get_title().startsWith(c.text)));')" \
    "the bar has one tab per window, the active one highlighted, labelled with the title"

# 10. Placement, stacking and visibility.
shell_eval "$(js 'M.groupFor(smoke.kept).active.move_resize_frame(false, 200, 300, 900, 500); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return rect(g.active) === "200,300,900,500" && barOnActive(g);')" \
    "bar follows move_resize_frame"
echo "PASS: bar y + height == frame.y and width == frame.width after a move"
shell_eval "$(js 'smoke.calc.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.display.focus_window === smoke.calc;')" "calculator raised"
check "$(js 'const g = M.groupFor(smoke.kept); const order = global.window_group.get_children();
    const at = a => order.indexOf(a); const active = at(g.active.get_compositor_private());
    return at(g.view) === active + 1 && at(smoke.calc.get_compositor_private()) > at(g.view);')" \
    "bar is just above the active window and below a window raised over it"
shell_eval "$(js 'M.groupFor(smoke.kept).active.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); const order = global.window_group.get_children();
    return order.indexOf(g.view) === order.indexOf(g.active.get_compositor_private()) + 1 &&
        order.indexOf(g.view) > order.indexOf(smoke.calc.get_compositor_private());')" "bar restacked with the raised group"
echo "PASS: bar restacked just above the active window"
shell_eval 'Main.overview.show(); true' >/dev/null
wait_until "$(js 'return Main.overview.visible && !M.groupFor(smoke.kept).view.visible;')" "bar hidden in the overview"
shell_eval 'Main.overview.hide(); true' >/dev/null
wait_until "$(js 'return !Main.overview.visible && M.groupFor(smoke.kept).view.visible;')" "bar shown after the overview"
echo "PASS: bar hidden while the overview is open"
shell_eval "$(js 'M.groupFor(smoke.kept).active.minimize(); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.windows.every(w => w.minimized) && !g.view.visible;')" \
    "minimizing the active tab minimizes the whole group"
echo "PASS: bar hidden while the group is minimized"
echo "PASS: minimizing the active tab minimizes the whole group"
# Restoring a hidden tab (dash, Alt+Tab) brings the whole group back with that tab in front.
shell_eval "$(js 'const g = M.groupFor(smoke.kept); smoke.back = g.windows.find(w => w !== g.active);
    smoke.back.activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.active === smoke.back && stacked(g) && g.view.visible && barOnActive(g) &&
    rect(g.windows[0]) === rect(g.windows[1]);')" "restoring a hidden tab restores the group with it in front"
echo "PASS: restoring any tab restores the whole group, that tab in front"
check 'Main.wm._skippedActors.size === 0' "every skipped minimize/unminimize effect was consumed"
# A switch only raises: no member is moved or resized.
shell_eval "$(js 'const g = M.groupFor(smoke.kept); smoke.moves = 0;
    for (const w of g.windows) { const m = w.move_resize_frame.bind(w); w.move_resize_frame = (...a) => { smoke.moves++; return m(...a); }; }
    smoke.prev = g.active; g.cycle(1); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.active !== smoke.prev && stacked(g) &&
    global.display.focus_window === g.active;')" "cycled by raising"
check "$(js 'const g = M.groupFor(smoke.kept); for (const w of g.windows) delete w.move_resize_frame; return smoke.moves === 0;')" \
    "switching tabs moves or resizes no window"
# A drag makes the hidden tabs transparent, then they catch up with the final rect and reappear.
shell_eval "$(js 'const g = M.groupFor(smoke.kept); smoke.hid = g.windows.find(w => w !== g.active);
    global.display.emit("grab-op-begin", g.active, imports.gi.Meta.GrabOp.MOVING);
    g.active.move_frame(true, 260, 340); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.active.get_frame_rect().x === 260 &&
    smoke.hid.get_compositor_private().opacity === 0 && rect(smoke.hid) === "200,300,900,500";')" \
    "hidden tab transparent and left in place during the drag"
shell_eval "$(js 'const g = M.groupFor(smoke.kept); global.display.emit("grab-op-end", g.active, imports.gi.Meta.GrabOp.MOVING); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return rect(smoke.hid) === "260,340,900,500" &&
    smoke.hid.get_compositor_private().opacity === 255 && stacked(g);')" "hidden tab follows the drag and reappears"
echo "PASS: a drag hides the other tabs, then they follow the window and reappear"
shell_eval "$(js 'M.groupFor(smoke.kept).active.move_frame(true, 200, 300); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.windows.every(w => rect(w) === "200,300,900,500");')" \
    "keyboard-style move: hidden tabs follow without a grab"
shell_eval "$(js 'M.groupFor(smoke.kept).active.make_fullscreen(); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.active.is_fullscreen() && !g.view.visible;')" "bar hidden for a fullscreen window"
shell_eval "$(js 'M.groupFor(smoke.kept).active.unmake_fullscreen(); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return !g.active.is_fullscreen() && rect(g.active) === "200,300,900,500" && barOnActive(g);')" \
    "bar back after leaving fullscreen"
echo "PASS: bar hidden while the active window is fullscreen"
# Switching tabs from a fullscreen window keeps the slot from before fullscreen.
shell_eval "$(js 'const g = M.groupFor(smoke.kept); smoke.fs = g.active; smoke.fs.make_fullscreen(); return true;')" >/dev/null
wait_until "$(js 'return smoke.fs.is_fullscreen() && rect(smoke.fs) !== "200,300,900,500";')" "active window fullscreen"
shell_eval "$(js 'M.groupFor(smoke.kept).cycle(1); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.active !== smoke.fs && !smoke.fs.minimized &&
    rect(g.active) === "200,300,900,500" && barOnActive(g);')" "tab switched from fullscreen takes the pre-fullscreen slot"
shell_eval "$(js 'smoke.fs.unmake_fullscreen(); return true;')" >/dev/null
wait_until "$(js 'return !smoke.fs.is_fullscreen();')" "hidden tab left fullscreen"
echo "PASS: switching tabs from a fullscreen window keeps the pre-fullscreen slot"
shell_eval "$(js 'global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.workspace_manager.get_active_workspace_index() === 1 && !M.groupFor(smoke.kept).view.visible &&
    !Main.wm._workspaceAnimation._switchData;')" "bar hidden on another workspace"
shell_eval "$(js 'global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.workspace_manager.get_active_workspace_index() === 0 && barOnActive(M.groupFor(smoke.kept)) &&
    !Main.wm._workspaceAnimation._switchData;')" \
    "bar back on the group's workspace"
echo "PASS: bar hidden while the group's workspace is not active"
# A user move that ends against the top of the work area takes the bar's height out of the window.
shell_eval "$(js 'const g = M.groupFor(smoke.kept); const w = g.active.get_work_area_current_monitor();
    smoke.top = w.y; g.active.move_frame(true, 200, w.y); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return g.active.get_frame_rect().y === smoke.top && g.view.y < smoke.top;')" \
    "window dragged against the top, bar under the panel"
shell_eval "$(js 'const g = M.groupFor(smoke.kept); global.display.emit("grab-op-end", g.active, imports.gi.Meta.GrabOp.MOVING); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.kept); return rect(g.active) === [200, smoke.top + g.view.barHeight, 900, 500 - g.view.barHeight].join(",") &&
    g.view.y === smoke.top && barOnActive(g);')" "bar back below the panel after the move ends"
echo "PASS: a move ending at the top of the work area takes the bar height out of the window"
shell_eval "$(js 'M.groupFor(smoke.kept).active.move_resize_frame(true, 200, 300, 900, 500); return true;')" >/dev/null
wait_until "$(js 'return rect(M.groupFor(smoke.kept).active) === "200,300,900,500";')" "window moved back down"
shell_eval "$(js 'const g = M.groupFor(smoke.kept); global.display.emit("grab-op-end", g.active, imports.gi.Meta.GrabOp.MOVING); return true;')" >/dev/null
sleep 0.5
check "$(js 'const g = M.groupFor(smoke.kept); return rect(g.active) === "200,300,900,500" && barOnActive(g) && g._carved === null;')" \
    "a move ending away from the top keeps the frame and forgets the carve"

# 11. Mouse, through a virtual pointer so real input picking is exercised.
launch_client gnome-text-editor --new-window
wait_until "$(js 'return eds().length === 3 && M.groupFor(smoke.kept)?.size === 3;')" "third tab"
launch_client gnome-text-editor --new-window
wait_until "$(js 'const g = M.groupFor(smoke.kept); return eds().length === 4 && g?.size === 4 && g.view.get_n_children() === 4;')" "fourth tab"
shell_eval "$(js 'smoke.group = M.groupFor(smoke.kept); return true;')" >/dev/null
inactive_tab='(() => { const g = smoke.group; const i = g.windows.findIndex(w => w !== g.active);
    smoke.before = g.active; smoke.target = g.windows[i]; return g.view.get_child_at_index(i); })()'
click "$inactive_tab" 1
wait_until "$(js 'return smoke.group.active === smoke.target && stacked(smoke.group);')" \
    "left-click switches to the tab"
echo "PASS: left-click on a tab switches to it"
shell_eval "$(js 'const g = smoke.group; smoke.before = g.active;
    smoke.target = g.windows[(g.windows.indexOf(g.active) + 1) % g.size]; return true;')" >/dev/null
scroll_bar "smoke.group.view"
wait_until "$(js 'return smoke.group.active === smoke.target;')" "scroll cycles one tab"
sleep 0.5
check "$(js 'return smoke.group.active === smoke.target;')" "one wheel notch cycles exactly one tab"
click "$inactive_tab.get_child().get_last_child()" 1 0.5
wait_until "$(js 'return eds().length === 3 && smoke.group.size === 3 && !eds().includes(smoke.target) &&
    smoke.group.active === smoke.before;')" "× closes only that window"
echo "PASS: × closes only its window and does not switch tabs"
click "$inactive_tab" 2
wait_until "$(js 'return eds().length === 2 && smoke.group.size === 2 && !eds().includes(smoke.target) &&
    smoke.group.active === smoke.before;')" "middle-click closes the tab's window"
echo "PASS: middle-click closes only that window"
click "$inactive_tab" 3
wait_until "$(js 'const t = smoke.target; return smoke.group.size === 1 && M.groupFor(t) === null && !t.minimized &&
    global.display.focus_window === t && smoke.group.active === smoke.before && stacked(smoke.group);')" \
    "right-click detaches the tab's window"
wait_until "$(js 'const s = smoke.group.slot; const f = smoke.target.get_frame_rect(); return f.x > s.x && f.y > s.y;')" \
    "detached window offset from the group"
echo "PASS: right-click detaches the window, visible and offset"
check "$(js 'return !smoke.group.view.visible;')" "bar hidden for a single-window group"

# 12. Maximize while tabbed, and re-maximize when the group drops to one window.
shell_eval "$(js 'M.attach(smoke.target); return true;')" >/dev/null
wait_until "$(js 'return smoke.group.size === 2 && smoke.group.active !== smoke.target && stacked(smoke.group) && smoke.group.view.visible;')" "tab re-attached"
# It had the keyboard when it was attached behind: the front tab takes it over.
wait_until "$(js 'return global.display.focus_window === smoke.group.active;')" "front tab focused"
echo "PASS: a focused window attached as a hidden tab hands focus to the front tab"
shell_eval "$(js 'const a = smoke.group.active; smoke.moves = 0;
    const move = a.move_resize_frame.bind(a); a.move_resize_frame = (...args) => { smoke.moves++; return move(...args); };
    a.maximize(); return true;')" >/dev/null
wait_until "$(js 'const a = smoke.group.active; const w = a.get_work_area_current_monitor(); const h = smoke.group.view.barHeight;
    return a.get_maximize_flags() === 0 && rect(a) === [w.x, w.y + h, w.width, w.height - h].join(",") && barOnActive(smoke.group);')" \
    "maximized window plus bar fill the work area"
sleep 1
check "$(js 'const a = smoke.group.active; delete a.move_resize_frame; return smoke.moves === 1 && a.get_maximize_flags() === 0;')" \
    "maximize leads to exactly one corrective move"
echo "PASS: maximizing a tabbed window leaves the work area to bar + window"
shell_eval "$(js 'smoke.maxed = smoke.group.active; Main.extensionManager.disableExtension("growi@9ticks.github.io"); return true;')" >/dev/null
wait_until "$(js 'return !M && smoke.maxed.is_maximized() && !smoke.maxed.minimized;')" \
    "disabling dissolves the layout and re-maximizes"
shell_eval 'Main.extensionManager.enableExtension("growi@9ticks.github.io"); true' >/dev/null
wait_until "$(js 'const a = smoke.maxed; const g = M?.groupFor(a); const w = a.get_work_area_current_monitor();
    if (g?.size !== 2 || g.active !== a) return false; const h = g.view.barHeight; smoke.group = g;
    return a.get_maximize_flags() === 0 && rect(a) === [w.x, w.y + h, w.width, w.height - h].join(",") && barOnActive(g);')" \
    "re-enabling forms the layout on a maximized window"
echo "PASS: disable re-maximizes, enable takes the bar height out of a maximized window"
shell_eval "$(js 'smoke.group.active.delete(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return smoke.group.size === 1 && smoke.group.active === smoke.target && !smoke.target.minimized &&
    smoke.target.is_maximized();')" "single remaining window maximized again"
echo "PASS: dropping to one window re-maximizes it"

# 13. Toggle-grouping shortcut: attaches a window outside the rules, then detaches it.
check "$(js 'return Main.wm._allowedKeybindings["toggle-grouping"] === Shell.ActionMode.NORMAL;')" "toggle-grouping registered"
shell_eval "$(js 'calcWin().activate(global.get_current_time()); return true;')" >/dev/null
wait_until "$(js 'return global.display.focus_window === calcWin();')" "calculator focused"
press_keys KEY_Super_L KEY_Alt_L KEY_g
wait_until "$(js 'const g = M.groupFor(calcWin()); return g?.size === 1 && g.active === calcWin() && M._forced.has(calcWin());')" \
    "Super+Alt+G attaches a window outside the rules"
echo "PASS: Super+Alt+G attaches a non-rule window to a new group"
shell_eval "$(js 'M.toggleFocused(); return true;')" >/dev/null
wait_until "$(js 'return M.groupFor(calcWin()) === null && !calcWin().minimized && !M._forced.has(calcWin());')" "toggle detaches it again"
echo "PASS: toggling again detaches the window"
shell_eval "$(js 'M.toggleFocused(); return true;')" >/dev/null
wait_until "$(js 'return M.groupFor(calcWin())?.size === 1;')" "calculator force-attached again"

# 14. Live settings: bar height, single-tab bar, app rules (during a drag and while minimized).
launch_client gnome-text-editor --new-window
wait_until "$(js 'const g = M.groupFor(smoke.target); smoke.group = g;
    return eds().length === 2 && g?.size === 2 && stacked(g) && barOnActive(g) && rect(g.windows[0]) === rect(g.windows[1]);')" \
    "second editor window joins the maximized one"
carved_at() {
    echo "$(js "const g = smoke.group; const a = g.active; const w = a.get_work_area_current_monitor(); const h = g.view.barHeight;
        const scale = imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return h === $1 * scale && rect(a) === [w.x, w.y + h, w.width, w.height - h].join(\",\") && barOnActive(g) &&
            g.windows.every(x => rect(x) === rect(a));")"
}
shell_eval "$(js 'M.settings.set_int("tab-bar-height", 44); return true;')" >/dev/null
wait_until "$(carved_at 44)" "taller bar re-carves the window and the hidden tab follows"
echo "PASS: changing tab-bar-height resizes the bar, frame top equals bar bottom"
# Through the gsettings CLI, as the preferences window writes it from its own process.
growi_gsettings set tab-bar-height 30
wait_until "$(carved_at 30)" "bar height back to 30 from another process"
echo "PASS: a tab-bar-height change from another process is picked up"
shell_eval "$(js 'M.settings.set_boolean("show-single-tab", true); return true;')" >/dev/null
wait_until "$(js 'return barOnActive(M.groupFor(calcWin()));')" "single-window group shows its bar"
shell_eval "$(js 'M.settings.set_boolean("show-single-tab", false); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(calcWin()); return !g.view.visible && !g._tabbed;')" "single-window group hides its bar"
echo "PASS: show-single-tab forms and dissolves the layout of a 1-window group"
shell_eval "$(js 'const g = smoke.group; smoke.hid = g.windows.find(w => w !== g.active); smoke.eds = eds();
    global.display.emit("grab-op-begin", g.active, imports.gi.Meta.GrabOp.MOVING);
    const f = g.active.get_frame_rect(); g.active.move_frame(true, f.x + 40, f.y + 40); return true;')" >/dev/null
wait_until "$(js 'return smoke.hid.get_compositor_private().opacity === 0;')" "hidden tab transparent during the drag"
shell_eval "$(js 'M.settings.set_strv("app-rules", []); return true;')" >/dev/null
wait_until "$(js 'return smoke.eds.every(w => M.groupFor(w) === null && !w.minimized) && opaque(smoke.eds) &&
    apart(smoke.eds) && M.groupFor(calcWin())?.size === 1;')" "clearing the rules mid-drag releases the editors, the forced window stays grouped"
echo "PASS: clearing app-rules releases every editor window, visible, opaque and fanned out; forced window kept"
shell_eval "$(js 'global.display.emit("grab-op-end", smoke.eds[0], imports.gi.Meta.GrabOp.MOVING);
    M.settings.set_strv("app-rules", ["org.gnome.TextEditor.desktop"]); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.eds[0]); smoke.group = g;
    return g?.size === 2 && M.groupFor(smoke.eds[1]) === g && stacked(g) && barOnActive(g);')" "restoring the rules regroups"
echo "PASS: restoring app-rules groups the editor windows again"
shell_eval "$(js 'smoke.group.active.minimize(); return true;')" >/dev/null
wait_until "$(js 'return smoke.eds.every(w => w.minimized);')" "editor group minimized"
shell_eval "$(js 'M.settings.set_strv("app-rules", []); return true;')" >/dev/null
wait_until "$(js 'return smoke.eds.every(w => M.groupFor(w) === null && !w.minimized) && opaque(smoke.eds) && apart(smoke.eds);')" \
    "clearing the rules restores a minimized group's windows, fanned out"
echo "PASS: clearing app-rules while the group is minimized leaves its windows visible"
shell_eval "$(js 'M.settings.set_strv("app-rules", ["org.gnome.TextEditor.desktop"]); return true;')" >/dev/null
wait_until "$(js 'const g = M.groupFor(smoke.eds[0]); return g?.size === 2 && stacked(g);')" "regrouped after the minimized case"
check 'Main.wm._skippedActors.size === 0' "every skipped minimize/unminimize effect was consumed"

# 15. Preferences window: opens through gnome-extensions prefs without errors.
WAYLAND_DISPLAY=$DISPLAY_NAME GDK_BACKEND=wayland GDK_DEBUG=no-portals GTK_USE_PORTAL=0 \
    gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions >"$TMP/prefs.log" 2>&1 &
CLIENT_PIDS+=($!)
for _ in $(seq 1 40); do
    # Not a call to the service itself: that would D-Bus-activate a second
    # copy without WAYLAND_DISPLAY.
    [[ $(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell.Extensions 2>/dev/null) == "(true,)" ]] && break
    sleep 0.25
done
gnome-extensions prefs "$UUID" || fail "gnome-extensions prefs failed"
wait_until "$(js 'const name = Main.extensionManager.lookup("growi@9ticks.github.io").metadata.name;
    return global.get_window_actors().some(a => a.meta_window.get_title() === name);')" "preferences window shown"
sleep 1
if grep -qE 'JS ERROR|Failed to open preferences|Gtk-WARNING|Adwaita-WARNING' "$TMP/prefs.log"; then
    cat "$TMP/prefs.log"
    fail "preferences logged errors"
fi
shell_eval "$(js 'const name = Main.extensionManager.lookup("growi@9ticks.github.io").metadata.name;
    global.get_window_actors().map(a => a.meta_window).filter(w => w.get_title() === name)
        .forEach(w => w.delete(global.get_current_time())); return true;')" >/dev/null
echo "PASS: gnome-extensions prefs opens the preferences window without errors"

# 16. Preferences page driven programmatically (tools/prefs-check.js) with a
# fake app list; it writes app-rules, which the running extension follows.
WAYLAND_DISPLAY=$DISPLAY_NAME GDK_BACKEND=wayland GDK_DEBUG=no-portals GTK_USE_PORTAL=0 \
    timeout 60 gjs -m "$ROOT/tools/prefs-check.js" "$EXT_DIR/$UUID/schemas" >"$TMP/prefs-check.log" 2>&1 \
    || { cat "$TMP/prefs-check.log"; fail "prefs-check failed"; }
grep '^PASS' "$TMP/prefs-check.log"
if grep -qE 'JS ERROR|Gtk-WARNING|Gtk-CRITICAL|Adwaita-WARNING' "$TMP/prefs-check.log"; then
    cat "$TMP/prefs-check.log"
    fail "prefs-check logged errors"
fi

# 17. Disable: keybindings and bars gone, no JS errors from growi.
shell_eval 'Main.extensionManager.disableExtension("growi@9ticks.github.io"); true' >/dev/null
wait_until '!Main.extensionManager.lookup("growi@9ticks.github.io").stateObj._manager' "extension disabled"
check '["next-tab", "previous-tab", "toggle-grouping"].every(k => !(k in Main.wm._allowedKeybindings) ||
    Main.wm._allowedKeybindings[k] === Shell.ActionMode.NONE)' "keybindings removed on disable"
check "$(js 'return bars().length === 0;')" "tab bars destroyed on disable"
if grep -E 'JS ERROR|JS WARNING' "$LOG" | grep -q "$UUID"; then
    fail "growi@9ticks.github.io logged JS errors"
fi
echo "PASS: no growi@9ticks.github.io JS errors in the shell log"

echo "SMOKE PASS"
