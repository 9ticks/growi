export function assertEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`.trim());
}

export function assertTrue(value, message = 'expected true') {
    if (value !== true)
        throw new Error(message);
}

export function assertFalse(value, message = 'expected false') {
    if (value !== false)
        throw new Error(message);
}
