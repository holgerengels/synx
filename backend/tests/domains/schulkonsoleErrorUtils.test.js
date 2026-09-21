const { diagnoseIdentity, formatSchulkonsoleError } = require('../../src/students/domains/schulkonsoleErrorUtils');

describe('schulkonsoleErrorUtils', () => {
    describe('diagnoseIdentity', () => {
        it('should detect En Dash (U+2013) in firstName', () => {
            const identity = {
                userId: 'dorul.ker',
                firstName: 'Kerem–Arda', // contains U+2013
                lastName: 'Dorul',
                clazz: '1BK1P1'
            };
            const findings = diagnoseIdentity(identity);
            expect(findings).toHaveLength(1);
            expect(findings[0]).toContain("Vorname 'Kerem–Arda' enthält typografischen Gedankenstrich '–' (U+2013)");
        });

        it('should detect trailing spaces in lastName', () => {
            const identity = {
                userId: 'mueller.max',
                firstName: 'Max',
                lastName: 'Müller ',
                clazz: '10A'
            };
            const findings = diagnoseIdentity(identity);
            expect(findings).toHaveLength(1);
            expect(findings[0]).toContain("Nachname 'Müller ' enthält nachfolgende Leerzeichen (Trailing Space)");
        });

        it('should detect leading spaces', () => {
            const identity = {
                userId: 'mueller.max',
                firstName: ' Max',
                lastName: 'Müller',
                clazz: '10A'
            };
            const findings = diagnoseIdentity(identity);
            expect(findings).toHaveLength(1);
            expect(findings[0]).toContain("Vorname ' Max' enthält führende Leerzeichen");
        });

        it('should detect non-breaking spaces (U+00A0)', () => {
            const identity = {
                userId: 'mueller.max',
                firstName: 'Max\u00A0Peter',
                lastName: 'Müller',
                clazz: '10A'
            };
            const findings = diagnoseIdentity(identity);
            expect(findings).toHaveLength(1);
            expect(findings[0]).toContain('geschütztes Leerzeichen (No-Break Space U+00A0)');
        });

        it('should detect forbidden AD characters', () => {
            const identity = {
                userId: 'test/user',
                firstName: 'Test',
                lastName: 'User:Admin',
                clazz: '10A'
            };
            const findings = diagnoseIdentity(identity);
            expect(findings).toHaveLength(2);
            expect(findings[0]).toContain("Benutzerkennung 'test/user' enthält für Benutzerkonten unzulässige Zeichen (/)");
            expect(findings[1]).toContain("Nachname 'User:Admin' enthält für Benutzerkonten unzulässige Zeichen (:)");
        });

        it('should return empty array for clean identity', () => {
            const identity = {
                userId: 'mustermann.max',
                firstName: 'Max-Moritz', // standard ASCII hyphen
                lastName: 'Mustermann',
                clazz: '10A'
            };
            const findings = diagnoseIdentity(identity);
            expect(findings).toEqual([]);
        });
    });

    describe('formatSchulkonsoleError', () => {
        it('should format Axios 400 error with diagnosis for Kerem–Arda', () => {
            const err = new Error('Request failed with status code 400');
            err.response = {
                status: 400,
                data: ''
            };
            const identity = {
                userId: 'dorul.ker',
                firstName: 'Kerem–Arda',
                lastName: 'Dorul'
            };

            const msg = formatSchulkonsoleError(err, identity);
            expect(msg).toContain('Request failed with status code 400');
            expect(msg).toContain("Hinweis: Vorname 'Kerem–Arda' enthält typografischen Gedankenstrich '–' (U+2013)");
        });

        it('should extract server error message from JSON data and combine with diagnosis', () => {
            const err = new Error('Request failed with status code 400');
            err.response = {
                status: 400,
                data: {
                    message: 'Ungültige Zeichen im Vornamen'
                }
            };
            const identity = {
                userId: 'dorul.ker',
                firstName: 'Kerem–Arda',
                lastName: 'Dorul'
            };

            const msg = formatSchulkonsoleError(err, identity);
            expect(msg).toContain('Request failed with status code 400: Ungültige Zeichen im Vornamen');
            expect(msg).toContain("Hinweis: Vorname 'Kerem–Arda' enthält typografischen Gedankenstrich '–' (U+2013)");
        });

        it('should extract validation errors map from ASP.NET style response', () => {
            const err = new Error('Request failed with status code 400');
            err.response = {
                status: 400,
                data: {
                    title: 'One or more validation errors occurred.',
                    errors: {
                        givenName: ['The givenName field contains invalid characters.']
                    }
                }
            };
            const identity = {
                userId: 'dorul.ker',
                firstName: 'Kerem–Arda',
                lastName: 'Dorul'
            };

            const msg = formatSchulkonsoleError(err, identity);
            expect(msg).toContain('One or more validation errors occurred.');
            expect(msg).toContain('givenName: The givenName field contains invalid characters.');
        });

        it('should handle non-400 errors without false diagnosis', () => {
            const err = new Error('Request failed with status code 500');
            err.response = {
                status: 500,
                data: { message: 'Internal Server Error' }
            };
            const identity = {
                userId: 'dorul.ker',
                firstName: 'Kerem–Arda',
                lastName: 'Dorul'
            };

            const msg = formatSchulkonsoleError(err, identity);
            expect(msg).toBe('Request failed with status code 500: Internal Server Error');
            expect(msg).not.toContain('Hinweis');
        });

        it('should handle plain error without response object', () => {
            const err = new Error('Connection refused');
            const msg = formatSchulkonsoleError(err, null);
            expect(msg).toBe('Connection refused');
        });
    });
});
