// The preferences page, built from GTK and Adw only (no import from the
// Extensions app) so tools/prefs-check.js can build and drive it with plain gjs.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {addRule, filterApps, hasRule, isCovered, removeRule, resolveRule} from './appRules.js';
import {splitList} from './util.js';

const RULES_KEY = 'app-rules';
const GENERIC_ICON = 'application-x-executable-symbolic';
const ICON_SIZE = 32;
const UNRESOLVED_SUBTITLES = {'missing-app': 'App not installed', 'unknown': 'WM class'};

const SHORTCUTS = [
    ['next-tab', 'Next tab'],
    ['previous-tab', 'Previous tab'],
    ['toggle-grouping', 'Attach or detach the focused window'],
];

/**
 * @param {Gio.Settings} settings the growi settings
 * @param {object} [options]
 * @param {Function} [options.loadApps] returns the apps offered by the picker as
 *   {id, name, startupWmClass, keywords, icon} objects (`icon` a Gio.Icon or null);
 *   called when the page is built and each time the picker opens
 * @returns {Adw.PreferencesPage}
 */
export function buildPreferencesPage(settings, {loadApps = loadInstalledApps} = {}) {
    const page = new Adw.PreferencesPage();
    page.add(buildGroupingGroup(settings, loadApps));
    page.add(buildTabBarGroup(settings));
    page.add(buildShortcutsGroup(settings));
    return page;
}

function buildGroupingGroup(settings, loadApps) {
    let apps = loadApps();
    const group = new Adw.PreferencesGroup({
        title: 'Grouping',
        description: 'Windows of these applications are grouped automatically.',
    });

    const addApp = new Gtk.Button({
        child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'Add application…'}),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    addApp.connect('clicked', () => {
        apps = loadApps();
        rebuild();
        showAppPicker(group, settings, apps);
    });
    group.set_header_suffix(addApp);

    const addById = new Adw.ButtonRow({title: 'Add by ID…', start_icon_name: 'list-add-symbolic'});
    addById.connect('activated', () => showAddById(group, settings));

    let rows = [];
    const rebuild = () => {
        for (const row of rows)
            group.remove(row);
        const rules = settings.get_strv(RULES_KEY);
        rows = rules.length === 0 ? [emptyRow()] : rules.map(rule => ruleRow(resolveRule(rule, apps),
            () => updateRules(settings, current => removeRule(current, rule))));
        rows.push(addById);
        for (const row of rows)
            group.add(row);
    };

    // Deferred so a remove button is never destroyed inside its own click handler.
    let rebuildId = 0;
    const changedId = settings.connect(`changed::${RULES_KEY}`, () => {
        rebuildId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            rebuildId = 0;
            rebuild();
            return GLib.SOURCE_REMOVE;
        });
    });
    group.connect('destroy', () => {
        settings.disconnect(changedId);
        if (rebuildId)
            GLib.source_remove(rebuildId);
        rebuildId = 0;
    });

    rebuild();
    return group;
}

function updateRules(settings, change) {
    settings.set_strv(RULES_KEY, change(settings.get_strv(RULES_KEY)));
}

function ruleRow({rule, app, kind}, onRemove) {
    const row = new Adw.ActionRow({
        title: app?.name ?? rule,
        subtitle: app ? rule : UNRESOLVED_SUBTITLES[kind],
        use_markup: false,
    });
    row.add_prefix(appIcon(app));
    const remove = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        tooltip_text: 'Remove',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    remove.connect('clicked', onRemove);
    row.add_suffix(remove);
    return row;
}

function emptyRow() {
    return new Adw.ActionRow({
        title: 'No applications',
        subtitle: 'Windows are then only grouped with the “Attach or detach the focused window” shortcut.',
    });
}

function appIcon(app) {
    const image = new Gtk.Image({pixel_size: ICON_SIZE, css_classes: ['lowres-icon']});
    if (app?.icon)
        image.gicon = app.icon;
    else
        image.icon_name = GENERIC_ICON;
    return image;
}

/** Installed apps as the plain objects appRules.js expects, plus their Gio.Icon. */
function loadInstalledApps() {
    return Gio.AppInfo.get_all()
        .filter(info => info.should_show() && info.get_id())
        .map(info => ({
            id: info.get_id(),
            name: info.get_display_name() || info.get_name() || info.get_id(),
            startupWmClass: info.get_startup_wm_class?.() ?? null,
            keywords: info.get_keywords?.() ?? [],
            icon: info.get_icon(),
        }));
}

function showAppPicker(parent, settings, apps) {
    const rules = settings.get_strv(RULES_KEY);
    const dialog = new Adw.Dialog({title: 'Add Application', content_width: 460, content_height: 600});

    const search = new Gtk.SearchEntry({placeholder_text: 'Search applications', hexpand: true});
    const searchBar = new Gtk.Box({margin_start: 12, margin_end: 12, margin_bottom: 6});
    searchBar.append(search);

    const list = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
        valign: Gtk.Align.START,
        margin_top: 6, margin_bottom: 12, margin_start: 12, margin_end: 12,
    });
    list.set_placeholder(new Gtk.Label({label: 'No applications found', margin_top: 12, margin_bottom: 12}));
    const rowApps = new Map();
    for (const app of filterApps(apps, '')) {
        const row = pickerRow(app, isCovered(app, rules));
        row.connect('activated', () => {
            updateRules(settings, current => addRule(current, app.id));
            dialog.close();
        });
        rowApps.set(row, app);
        list.append(row);
    }

    let visible = null;
    list.set_filter_func(row => !visible || visible.has(rowApps.get(row)));
    search.connect('search-changed', () => {
        visible = new Set(filterApps(apps, search.text));
        list.invalidate_filter();
    });

    const view = new Adw.ToolbarView({
        content: new Gtk.ScrolledWindow({
            child: list,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }),
    });
    view.add_top_bar(new Adw.HeaderBar());
    view.add_top_bar(searchBar);
    dialog.child = view;
    dialog.focus_widget = search;
    dialog.present(parent);
}

function pickerRow(app, covered) {
    const row = new Adw.ActionRow({
        title: app.name,
        subtitle: app.id,
        use_markup: false,
        activatable: !covered,
        sensitive: !covered,
    });
    row.add_prefix(appIcon(app));
    if (covered) {
        row.add_suffix(new Gtk.Image({icon_name: 'object-select-symbolic', tooltip_text: 'Already added'}));
        row.tooltip_text = 'Already added';
    }
    return row;
}

function showAddById(parent, settings) {
    const dialog = new Adw.AlertDialog({
        heading: 'Add by ID',
        body: 'A desktop app ID (e.g. google-chrome.desktop) or a WM class, as shown by Looking Glass.',
        default_response: 'add',
        close_response: 'cancel',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('add', 'Add');
    dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

    const entry = new Gtk.Entry({placeholder_text: 'WM class or app ID', activates_default: true});
    // Blank input only disables Add; the error style is kept for something
    // typed that cannot be added (whitespace or an existing rule).
    const validate = () => {
        const rule = entry.text.trim();
        const valid = rule.length > 0 && !hasRule(settings.get_strv(RULES_KEY), rule);
        dialog.set_response_enabled('add', valid);
        if (valid || entry.text === '')
            entry.remove_css_class('error');
        else
            entry.add_css_class('error');
        return valid;
    };
    entry.connect('changed', validate);
    validate();
    dialog.extra_child = entry;

    dialog.connect('response', (_dialog, response) => {
        if (response === 'add' && validate())
            updateRules(settings, current => addRule(current, entry.text));
    });
    dialog.present(parent);
}

function buildTabBarGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Tab bar'});

    const [, [min, max]] = settings.settings_schema.get_key('tab-bar-height').get_range().recursiveUnpack();
    const height = Adw.SpinRow.new_with_range(min, max, 1);
    height.title = 'Height';
    height.subtitle = 'In logical pixels';
    settings.bind('tab-bar-height', height, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(height);

    const single = new Adw.SwitchRow({
        title: 'Show for a single window',
        subtitle: 'Keep the tab bar when a group has only one window',
    });
    settings.bind('show-single-tab', single, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(single);
    return group;
}

function buildShortcutsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Shortcuts',
        // Parsed as Pango markup.
        description: 'GTK accelerators such as &lt;Super&gt;&lt;Alt&gt;Page_Down, separated by commas. ' +
            'Leave empty to disable a shortcut.',
    });
    for (const [key, title] of SHORTCUTS)
        group.add(listRow(settings, key, title, isAccelerator));
    return group;
}

/**
 * An entry editing a string-list key as comma-separated text. Edits are saved
 * on apply only when every entry passes `isValid`; otherwise the row is
 * marked as an error and the key keeps its value.
 */
function listRow(settings, key, title, isValid) {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    const load = () => {
        row.text = settings.get_strv(key).join(', ');
        row.remove_css_class('error');
    };
    const validate = () => {
        const valid = splitList(row.text).every(isValid);
        if (valid)
            row.remove_css_class('error');
        else
            row.add_css_class('error');
        return valid;
    };

    load();
    row.connect('changed', validate);
    row.connect('apply', () => {
        if (!validate())
            return;
        settings.set_strv(key, splitList(row.text));
        // Shows the saved, normalized list.
        load();
    });
    const id = settings.connect(`changed::${key}`, load);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function isAccelerator(text) {
    const [ok, keyval] = Gtk.accelerator_parse(text);
    return ok && keyval !== 0;
}
