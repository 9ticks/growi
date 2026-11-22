import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPreferencesPage} from './prefsWidgets.js';

export default class GrowiPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(buildPreferencesPage(this.getSettings()));
    }
}
