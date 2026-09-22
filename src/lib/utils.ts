import type { RpcStateInfo } from './types';

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
 * Converts a value of `datapoints.fn` to the type of the hm-rpc state. ReGa delivers some values as string,
 * although the hm-rpc state is a number, e.g. "STATE_NOT_AVAILABLE" for the ENUM VALVE_STATE of a not used
 * channel or an empty string for CUxD devices (hm-rpc #803, #1342, #1358).
 *
 * @param value value delivered by ReGa
 * @param info type information of the hm-rpc state
 * @returns the converted value or undefined, if it cannot be converted
 */
export function convertRegaValue(value: ioBroker.StateValue, info: RpcStateInfo): ioBroker.StateValue | undefined {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return undefined;
    }
    if (value === null || !info.type || info.type === 'mixed' || typeof value === info.type) {
        return value;
    }

    switch (info.type) {
        case 'number': {
            if (typeof value === 'boolean') {
                return value ? 1 : 0;
            }
            // ENUMs are stored as index of the VALUE_LIST
            const index = info.valueList ? info.valueList.indexOf(String(value)) : -1;
            if (index !== -1) {
                return index;
            }
            if (typeof value !== 'string' || !value.trim()) {
                return undefined;
            }
            const num = Number(value);
            return Number.isFinite(num) ? num : undefined;
        }
        case 'boolean':
            if (typeof value === 'number') {
                return value !== 0;
            }
            if (value === 'true' || value === '1') {
                return true;
            }
            if (value === 'false' || value === '0') {
                return false;
            }
            return undefined;
        case 'string':
            return String(value);
        default:
            return value;
    }
}

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
