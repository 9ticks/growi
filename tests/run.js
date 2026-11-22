// Minimal test runner: each *.test.js module exports `tests`, a map of name → function.
import System from 'system';

const MODULES = ['./util.test.js', './layout.test.js', './appRules.test.js'];

let failures = 0;
let total = 0;
for (const path of MODULES) {
    // eslint-disable-next-line no-await-in-loop
    const {tests} = await import(path);
    for (const [name, fn] of Object.entries(tests)) {
        total++;
        try {
            fn();
            print(`ok   - ${name}`);
        } catch (e) {
            failures++;
            print(`FAIL - ${name}\n       ${e.message}`);
        }
    }
}

print(`\n${total - failures}/${total} passed`);
System.exit(failures ? 1 : 0);
