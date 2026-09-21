/**
 * Utility functions for extracting and diagnosing Schulkonsole / Active Directory API errors.
 */

/**
 * Inspects identity fields for characters known to cause issues with
 * Active Directory, LDAP, or School Administration APIs (such as Schulkonsole / paedML).
 *
 * @param {Object} identity - The identity object ({ firstName, lastName, userId, clazz, ... })
 * @returns {string[]} Array of diagnostic hints, empty if no suspicious characters found.
 */
function diagnoseIdentity(identity) {
    if (!identity || typeof identity !== 'object') return [];

    const findings = [];
    const fields = [
        { name: 'Benutzerkennung', value: identity.userId },
        { name: 'Vorname', value: identity.firstName },
        { name: 'Nachname', value: identity.lastName },
        { name: 'Klasse', value: identity.clazz }
    ];

    for (const field of fields) {
        if (typeof field.value !== 'string' || field.value.length === 0) continue;
        const val = field.value;

        // 1. Check for leading / trailing whitespace
        if (/^\s+/.test(val) && /\s+$/.test(val)) {
            findings.push(`${field.name} '${val}' enthält führende und nachfolgende Leerzeichen`);
        } else if (/^\s+/.test(val)) {
            findings.push(`${field.name} '${val}' enthält führende Leerzeichen`);
        } else if (/\s+$/.test(val)) {
            findings.push(`${field.name} '${val}' enthält nachfolgende Leerzeichen (Trailing Space)`);
        }

        // 2. Check for typographic dashes:
        // U+2013 (En Dash), U+2014 (Em Dash), U+2212 (Minus Sign), U+2010 (Hyphen), U+2011 (Non-breaking hyphen)
        if (val.includes('\u2013')) {
            findings.push(`${field.name} '${val}' enthält typografischen Gedankenstrich '–' (U+2013) statt ASCII-Bindestrich '-'`);
        }
        if (val.includes('\u2014')) {
            findings.push(`${field.name} '${val}' enthält typografischen Geviertstrich '—' (U+2014) statt ASCII-Bindestrich '-'`);
        }
        if (val.includes('\u2212')) {
            findings.push(`${field.name} '${val}' enthält typografisches Minuszeichen '−' (U+2212) statt ASCII-Bindestrich '-'`);
        }
        if (val.includes('\u2010') || val.includes('\u2011')) {
            findings.push(`${field.name} '${val}' enthält Sonder-Bindestrich (U+2010/U+2011) statt ASCII-Bindestrich '-'`);
        }

        // 3. Check for unusual / non-breaking spaces
        if (val.includes('\u00A0')) {
            findings.push(`${field.name} '${val}' enthält geschütztes Leerzeichen (No-Break Space U+00A0)`);
        }
        if (val.includes('\u200B')) {
            findings.push(`${field.name} '${val}' enthält breitenloses Leerzeichen (Zero-Width Space U+200B)`);
        }

        // 4. Check for characters forbidden in Active Directory / SAM accounts / LDAP names: " / \ [ ] : ; | = , + * ? < >
        const forbiddenADMatch = val.match(/["/\\\[\]:;|=,+*?<>]/g);
        if (forbiddenADMatch) {
            const uniqueChars = [...new Set(forbiddenADMatch)].join(' ');
            findings.push(`${field.name} '${val}' enthält für Benutzerkonten unzulässige Zeichen (${uniqueChars})`);
        }
    }

    return findings;
}

/**
 * Extracts a human-readable, detailed error message from an error object (including Axios errors)
 * and enriches it with diagnosis hints if the request failed due to bad request (400) or validation.
 *
 * @param {Error|Object} err - The error object
 * @param {Object} [identity] - Optional identity being processed
 * @param {string} [prefix] - Optional prefix (e.g. 'Add error')
 * @returns {string} Formatted error message
 */
function formatSchulkonsoleError(err, identity = null, prefix = '') {
    if (!err) return prefix ? `${prefix}: Unbekannter Fehler` : 'Unbekannter Fehler';

    let baseMsg = err.message || String(err);
    let serverDetail = '';
    const status = err.response ? err.response.status : null;

    if (err.response && err.response.data) {
        const data = err.response.data;

        if (typeof data === 'string' && data.trim()) {
            const clean = data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (clean && clean !== baseMsg) {
                serverDetail = clean.length > 250 ? clean.substring(0, 247) + '...' : clean;
            }
        } else if (typeof data === 'object' && data !== null) {
            const serverMsg = data.message || data.Message || data.error || data.detail || data.title;
            const validationErrors = data.errors ? formatValidationErrors(data.errors) : null;

            const parts = [
                typeof serverMsg === 'string' ? serverMsg : (serverMsg ? JSON.stringify(serverMsg) : null),
                validationErrors
            ].filter(Boolean);

            if (parts.length > 0) {
                serverDetail = parts.join(' - ');
            } else {
                try {
                    const json = JSON.stringify(data);
                    if (json !== '{}') {
                        serverDetail = json.length > 250 ? json.substring(0, 247) + '...' : json;
                    }
                } catch (_) {}
            }
        }
    }

    let fullMsg = baseMsg;
    if (serverDetail && !fullMsg.includes(serverDetail)) {
        fullMsg += `: ${serverDetail}`;
    }

    // Run character diagnostics if status is 400 (Bad Request) or message suggests invalid input
    const isBadRequest = status === 400 || /status code 400|bad request/i.test(fullMsg);
    if (isBadRequest && identity && !fullMsg.includes('Hinweis:')) {
        const diagnostics = diagnoseIdentity(identity);
        if (diagnostics.length > 0) {
            fullMsg += ` (Hinweis: ${diagnostics.join('; ')})`;
        }
    }

    return prefix ? `${prefix}: ${fullMsg}` : fullMsg;
}

function formatValidationErrors(errors) {
    if (Array.isArray(errors)) {
        return errors.map(e => typeof e === 'object' ? (e.message || JSON.stringify(e)) : String(e)).join('; ');
    }
    if (typeof errors === 'object' && errors !== null) {
        const entries = [];
        for (const [key, val] of Object.entries(errors)) {
            const valStr = Array.isArray(val) ? val.join(', ') : (typeof val === 'object' ? JSON.stringify(val) : String(val));
            entries.push(`${key}: ${valStr}`);
        }
        return entries.join('; ');
    }
    return String(errors);
}

module.exports = {
    diagnoseIdentity,
    formatSchulkonsoleError
};
