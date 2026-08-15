/**
 * Legacy ioBroker credential obfuscation (XOR with the system secret).
 *
 * This must stay byte compatible with the admin UI (`encrypted: true` in jsonConfig.json),
 * because existing instances have their credentials stored with this scheme.
 */

/**
 * Encrypts a value with the given key
 *
 * @param key the secret from `system.config`
 * @param value the plain text value
 */
export function encrypt(key: string, value: string): string {
    let result = '';
    for (let i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

/**
 * Decrypts a value with the given key
 *
 * @param key the secret from `system.config`
 * @param value the encrypted value
 */
export function decrypt(key: string, value: string): string {
    let result = '';
    for (let i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}
