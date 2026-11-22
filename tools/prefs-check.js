// Builds the growi preferences page with plain gjs and drives it.
//
// Run only from tools/smoke.sh, inside its isolated session (private D-Bus,
// temp XDG dirs, keyfile GSettings backend, nested WAYLAND_DISPLAY): it
// writes the growi settings.
//
// Usage: gjs -m tools/prefs-check.js <schema dir>
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {buildPreferencesPage} from '../growi@9ticks.github.io/prefsWidgets.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.growi';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'keyfile' || !GLib.getenv('GROWI_SMOKE_INNER')) {
    printerr('prefs-check: refusing to run outside the smoke session');
    System.exit(2);
}

const [schemaDir] = System.programArgs;
const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir, Gio.SettingsSchemaSource.get_default(), false);
const newSettings = () => new Gio.Settings({settings_schema: source.lookup(SCHEMA_ID, false)});

Adw.init();

let failures = 0;

function check(what, ok) {
    if (ok) {
        print(`PASS: prefs ${what}`);
    } else {
        failures++;
        print(`FAIL: prefs ${what}`);
    }
}

function flush() {
    const context = GLib.MainContext.default();
    while (context.iteration(false))
        ;
}

/** Iterates the main loop until `predicate` holds or the timeout expires. */
function waitFor(predicate, timeoutMs = 3000) {
    const end = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < end) {
        flush();
        if (predicate())
            return true;
        GLib.usleep(10000);
    }
    return predicate();
}

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

const find = (root, type, pred = () => true) => [...descendants(root)].filter(w => w instanceof type && pred(w));
const titled = title => w => w.title === title;

const RULES = 'app-rules';
const DEFAULT_RULES = ['com.microsoft.VSCode.desktop', 'code.desktop', 'code-oss.desktop',
    'codium.desktop', 'Code', 'code'];
const FAKE_APPS = [
    {id: 'com.microsoft.VSCode.desktop', name: 'Visual Studio Code', startupWmClass: 'com.microsoft.VSCode',
        keywords: ['editor'], icon: Gio.ThemedIcon.new('text-editor')},
    {id: 'google-chrome.desktop', name: 'Google Chrome', startupWmClass: null, keywords: ['browser'], icon: null},
    {id: 'org.example.Notes.desktop', name: 'Notes', startupWmClass: 'notes-app', keywords: [], icon: null},
    {id: 'org.example.Term.desktop', name: 'Term Work', startupWmClass: null, keywords: ['shell'], icon: null},
];
const WM_CLASS = 'WM class';
const MISSING_APP = 'App not installed';

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function main() {
    const settings = newSettings();
    const originalRules = settings.get_strv(RULES);
    settings.set_strv(RULES, DEFAULT_RULES);

    const window = new Adw.Window({default_width: 600, default_height: 800});
    const page = buildPreferencesPage(settings, {loadApps: () => FAKE_APPS});
    window.set_content(page);
    window.present();
    check('window mapped', waitFor(() => window.get_mapped()));

    const ctx = {window, page, settings, group: find(page, Adw.PreferencesGroup, titled('Grouping'))[0]};
    checkUnchangedGroups(ctx);
    checkRuleRows(ctx);
    checkPicker(ctx);
    checkAddById(ctx);

    checkDisposal(ctx);

    settings.set_strv(RULES, originalRules);
    Gio.Settings.sync();
}

function checkDisposal({window, page, group, settings}) {
    const changed = GObject.signal_lookup('changed', Gio.Settings);
    const detail = GLib.quark_from_string(RULES);
    check('rules handler connected while the page lives',
        GObject.signal_has_handler_pending(settings, changed, detail, false));
    window.destroy();
    // GTK disposes the group when its last reference goes, which here waits on
    // gjs' garbage collector; dispose it now to check what disposal does.
    page.remove(group);
    group.run_dispose();
    check('rules handler disconnected when the group is disposed',
        !GObject.signal_has_handler_pending(settings, changed, detail, false));
    newSettings().set_strv(RULES, ['after-dispose']);
    check('a rules change after disposal is harmless', waitFor(() => settings.get_strv(RULES)[0] === 'after-dispose'));
}

function checkUnchangedGroups({page, settings}) {
    const [height] = find(page, Adw.SpinRow, titled('Height'));
    check('tab bar height row shows the setting',
        height?.value === settings.get_int('tab-bar-height'));
    const [single] = find(page, Adw.SwitchRow, titled('Show for a single window'));
    check('single-tab switch row shows the setting',
        single?.active === settings.get_boolean('show-single-tab'));
    const shortcuts = ['Next tab', 'Previous tab', 'Attach or detach the focused window']
        .map(title => find(page, Adw.EntryRow, titled(title))[0]);
    check('shortcut rows show the accelerators',
        shortcuts.every((row, i) =>
            row?.text === settings.get_strv(['next-tab', 'previous-tab', 'toggle-grouping'][i]).join(', ')));
}

const ruleRows = group => find(group, Adw.ActionRow);
const rowTexts = group => ruleRows(group).map(r => [r.title, r.subtitle]);
const rowIcon = row => {
    const [image] = find(row, Gtk.Image);
    return image?.gicon ? image.gicon.to_string() : image?.icon_name;
};

function checkRuleRows({group, settings}) {
    check('one row per rule in setting order: VS Code resolved, missing .desktop apps and WM classes labelled',
        sameList(rowTexts(group), [
            ['Visual Studio Code', 'com.microsoft.VSCode.desktop'],
            ['code.desktop', MISSING_APP], ['code-oss.desktop', MISSING_APP],
            ['codium.desktop', MISSING_APP], ['Code', WM_CLASS], ['code', WM_CLASS],
        ]));
    check('resolved rule shows the app icon, unresolved rule a generic one',
        rowIcon(ruleRows(group)[0]) === 'text-editor' &&
        rowIcon(ruleRows(group)[4]) === 'application-x-executable-symbolic');
    check('"Add by ID…" row and "Add application…" button present',
        find(group, Adw.ButtonRow, titled('Add by ID…')).length === 1 && addAppButton(group) !== undefined);

    const external = newSettings();
    external.set_strv(RULES, ['GOOGLE-CHROME', 'notes-app', 'Code']);
    check('rows follow an external set_strv (desktop ID and StartupWMClass resolved)',
        waitFor(() => sameList(rowTexts(group), [
            ['Google Chrome', 'GOOGLE-CHROME'], ['Notes', 'notes-app'], ['Code', WM_CLASS]])));

    const [, notes] = ruleRows(group);
    find(notes, Gtk.Button)[0].emit('clicked');
    check('remove deletes exactly that rule', sameList(settings.get_strv(RULES), ['GOOGLE-CHROME', 'Code']));
    check('rows follow the removal', waitFor(() => sameList(rowTexts(group).map(([t]) => t), ['Google Chrome', 'Code'])));

    settings.set_strv(RULES, []);
    check('empty rules show the placeholder row', waitFor(() => {
        const rows = ruleRows(group);
        return rows.length === 1 && rows[0].title === 'No applications' && rows[0].subtitle.includes('shortcut') &&
            find(rows[0], Gtk.Button).length === 0;
    }));
    settings.set_strv(RULES, ['com.microsoft.VSCode.desktop']);
    waitFor(() => ruleRows(group).length === 1 && ruleRows(group)[0].title === 'Visual Studio Code');
}

const addAppButton = group => find(group, Gtk.Button).find(b => b.child instanceof Adw.ButtonContent &&
    b.child.label === 'Add application…');

function checkPicker({window, group, settings}) {
    addAppButton(group).emit('clicked');
    check('"Add application…" opens the picker',
        waitFor(() => window.get_visible_dialog() instanceof Adw.Dialog && window.get_visible_dialog().get_mapped()));
    const dialog = window.get_visible_dialog();
    const rows = find(dialog, Adw.ActionRow);
    const shown = () => rows.filter(r => r.get_child_visible()).map(r => r.title);
    check('picker lists the apps sorted by name with their IDs',
        sameList(rows.map(r => [r.title, r.subtitle]), [
            ['Google Chrome', 'google-chrome.desktop'], ['Notes', 'org.example.Notes.desktop'],
            ['Term Work', 'org.example.Term.desktop'], ['Visual Studio Code', 'com.microsoft.VSCode.desktop']]));
    const vscode = rows[3];
    check('an app covered by a rule is marked and not sensitive',
        !vscode.sensitive && !vscode.activatable &&
        find(vscode, Gtk.Image).some(i => i.icon_name === 'object-select-symbolic') &&
        rows.slice(0, 3).every(r => r.sensitive && r.activatable));
    check('an app without an icon gets a generic one', rowIcon(rows[0]) === 'application-x-executable-symbolic');

    const [search] = find(dialog, Gtk.SearchEntry);
    search.text = 'BROWSER';
    check('search matches keywords', waitFor(() => sameList(shown(), ['Google Chrome'])));
    search.text = 'microsoft';
    check('search matches IDs', waitFor(() => sameList(shown(), ['Visual Studio Code'])));
    search.text = 'note';
    check('search matches names', waitFor(() => sameList(shown(), ['Notes'])));
    search.text = '';
    check('blank search shows every app', waitFor(() => shown().length === 4));

    rows[0].activate();
    check('picking an app appends its desktop ID',
        waitFor(() => sameList(settings.get_strv(RULES), ['com.microsoft.VSCode.desktop', 'google-chrome.desktop'])));
    check('picking an app closes the picker', waitFor(() => window.get_visible_dialog() === null));
}

function checkAddById({window, group, settings}) {
    find(group, Adw.ButtonRow, titled('Add by ID…'))[0].activate();
    check('"Add by ID…" opens a dialog',
        waitFor(() => window.get_visible_dialog() instanceof Adw.AlertDialog && window.get_visible_dialog().get_mapped()));
    const dialog = window.get_visible_dialog();
    const [entry] = find(dialog, Gtk.Entry);
    const refused = () => !dialog.get_response_enabled('add') && entry.has_css_class('error');

    check('empty input disables Add', !dialog.get_response_enabled('add'));
    entry.text = '   ';
    check('blank input is refused with the error style', refused());
    entry.text = ' GOOGLE-CHROME.desktop ';
    check('a duplicate (case-insensitive) is refused with the error style', refused());
    entry.text = '  Termwork  ';
    check('a new rule enables Add', dialog.get_response_enabled('add') && !entry.has_css_class('error'));
    find(dialog, Gtk.Button).find(b => b.label === 'Add').emit('clicked');
    check('Add appends the trimmed rule', waitFor(() => sameList(settings.get_strv(RULES),
        ['com.microsoft.VSCode.desktop', 'google-chrome.desktop', 'Termwork'])));
    check('Add closes the dialog', waitFor(() => window.get_visible_dialog() === null));
    check('the added rule shows as a WM class row',
        waitFor(() => sameList(rowTexts(group).at(-1), ['Termwork', WM_CLASS])));
}

try {
    main();
} catch (e) {
    failures++;
    print(`FAIL: prefs check threw: ${e}\n${e.stack}`);
}
System.exit(failures ? 1 : 0);
