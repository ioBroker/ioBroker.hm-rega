/**
 * The CCU writes strings with `WriteURL()`, which is *almost* but not quite `encodeURI`.
 * This table maps the sequences which `decodeURI` cannot handle back to their characters.
 */
export interface EscapeChar {
    regex: RegExp;
    replace: string;
}

export const chars: EscapeChar[] = [
    { regex: /%C4/g, replace: 'Ä' },
    { regex: /%D6/g, replace: 'Ö' },
    { regex: /%DC/g, replace: 'Ü' },
    { regex: /%E4/g, replace: 'ä' },
    { regex: /%F6/g, replace: 'ö' },
    { regex: /%FC/g, replace: 'ü' },
    { regex: /%DF/g, replace: 'ß' },
    { regex: /%u20AC/g, replace: 'Ђ' },
    { regex: /%20/g, replace: ' ' },
    { regex: /%5B/g, replace: '[' },
    { regex: /%5C/g, replace: "'" },
    { regex: /%5D/g, replace: ']' },
    { regex: /%5E/g, replace: '^' },
    { regex: /%5F/g, replace: '_' },
    { regex: /%60/g, replace: '`' },
    { regex: /%21/g, replace: '!' },
    { regex: /%22/g, replace: '"' },
    { regex: /%23/g, replace: '#' },
    { regex: /%24/g, replace: '$' },
    { regex: /%25/g, replace: '%' },
    { regex: /%26/g, replace: '&' },
    { regex: /%27/g, replace: "'" },
    { regex: /%3A/g, replace: ':' },
    { regex: /%3B/g, replace: ';' },
    { regex: /%3C/g, replace: '<' },
    { regex: /%3D/g, replace: '=' },
    { regex: /%3E/g, replace: '>' },
    { regex: /%3F/g, replace: '?' },
    { regex: /%40/g, replace: '@' },
    { regex: /%7B/g, replace: '{' },
    { regex: /%7C/g, replace: '|' },
    { regex: /%7D/g, replace: '}' },
    { regex: /%7E/g, replace: '~' },
    { regex: /%B0/g, replace: 'º' },
    { regex: /%B4/g, replace: ',' },
    { regex: /%B5/g, replace: 'µ' },
    { regex: /%BB/g, replace: '»' },
    { regex: /%28/g, replace: '(' },
    { regex: /%29/g, replace: ')' },
    { regex: /%2A/g, replace: '*' },
    { regex: /%2B/g, replace: '+' },
    { regex: /%2C/g, replace: ',' },
    { regex: /%2D/g, replace: '-' },
    { regex: /%2E/g, replace: '.' },
    { regex: /%2F/g, replace: '/' },
    { regex: /%A6/g, replace: '|' },
    { regex: /%A7/g, replace: '§' },
    { regex: /%AB/g, replace: '«' },
    { regex: /%/g, replace: '%25' },
    { regex: /%0A/g, replace: '\n' },
];

/** Characters which are not allowed in ioBroker object IDs */
export const FORBIDDEN_CHARS = /[\][*,;'"`<>\\?]/g;

/**
 * Reduces a (possibly translated) object name to a plain string
 *
 * @param name name of an ioBroker object
 */
export function nameToString(name: ioBroker.StringOrTranslated | undefined): string {
    if (typeof name === 'string') {
        return name;
    }
    return name?.en ?? '';
}
