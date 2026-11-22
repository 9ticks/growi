import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Test-only: unlocks org.gnome.Shell.Eval for tools/smoke.sh.
export default class SmokeHelperExtension extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
