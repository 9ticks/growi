import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {GroupManager} from './groupManager.js';

export default class GrowiExtension extends Extension {
    enable() {
        this._manager = new GroupManager(this.getSettings());
    }

    disable() {
        this._manager?.destroy();
        this._manager = null;
    }
}
