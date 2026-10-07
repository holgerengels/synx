// Setup mock config before requiring task
jest.mock('../../src/config', () => ({
    schulkonsole: {
        emailDomain: 'musterschule.schule.paedml'
    },
    settings: {
        devMode: false
    }
}));

const PaedmlSetEmailTask = require('../../src/students/tasks/PaedmlSetEmailTask');
const devModeUtils = require('../../src/utils/devMode');
const config = require('../../src/config');
const { getDomain } = require('../../src/domains/registry');

jest.mock('../../src/domains/registry', () => ({
    getDomain: jest.fn()
}));

describe('PaedmlSetEmailTask', () => {
    let task;

    beforeEach(() => {
        task = new PaedmlSetEmailTask();
        jest.restoreAllMocks();
        config.schulkonsole = {
            emailDomain: 'musterschule.schule.paedml'
        };
        config.settings = {
            devMode: false
        };
    });

    it('throws an error if config.schulkonsole.emailDomain is missing', async () => {
        delete config.schulkonsole.emailDomain;

        await expect(task.execute()).rejects.toThrow(
            'Schulkonsole emailDomain missing (config.schulkonsole.emailDomain).'
        );
    });

    it('identifies students needing email update and calls changeIdentity', async () => {
        const mockStudents = [
            { userId: 'userA', clazz: '10A', email: null },
            { userId: 'userB', clazz: '10B', email: 'userb@musterschule.schule.paedml' },
            { userId: 'userC', clazz: '10C', email: 'wrong@otherdomain.de' }
        ];

        const mockChangeIdentity = jest.fn().mockResolvedValue({});
        const mockSchulkonsole = {
            getIdentities: jest.fn().mockResolvedValue(mockStudents),
            changeIdentity: mockChangeIdentity
        };
        getDomain.mockReturnValue(mockSchulkonsole);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.totalStudents).toBe(3);
        expect(result.details.alreadySet).toBe(1); // userB
        expect(result.details.totalPending).toBe(2); // userA and userC
        expect(result.details.changed).toHaveLength(2);
        expect(result.details.errors).toHaveLength(0);

        expect(mockChangeIdentity).toHaveBeenCalledTimes(2);
        expect(mockChangeIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'userA', email: 'usera@musterschule.schule.paedml' })
        );
        expect(mockChangeIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'userC', email: 'userc@musterschule.schule.paedml' })
        );
    });

    it('limits updates in devMode', async () => {
        config.settings.devMode = true;

        const mockStudents = [
            { userId: 'userA', email: null },
            { userId: 'userB', email: null }
        ];
        const mockChangeIdentity = jest.fn().mockResolvedValue({});
        const mockSchulkonsole = {
            getIdentities: jest.fn().mockResolvedValue(mockStudents),
            changeIdentity: mockChangeIdentity
        };
        getDomain.mockReturnValue(mockSchulkonsole);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.devMode).toBe(true);
        expect(result.details.totalPending).toBe(2);
        expect(result.details.changed).toHaveLength(1);
        expect(result.details.skipped).toBe(1);
        expect(mockChangeIdentity).toHaveBeenCalledTimes(1);
    });

    it('handles changeIdentity errors gracefully', async () => {
        const mockStudents = [
            { userId: 'userA', email: null }
        ];
        const mockChangeIdentity = jest.fn().mockRejectedValue(new Error('Network error'));
        const mockSchulkonsole = {
            getIdentities: jest.fn().mockResolvedValue(mockStudents),
            changeIdentity: mockChangeIdentity
        };
        getDomain.mockReturnValue(mockSchulkonsole);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.changed).toHaveLength(0);
        expect(result.details.errors).toHaveLength(1);
        expect(result.details.errors[0].id).toBe('userA');
        expect(result.details.errors[0].message).toContain('Network error');
    });

    describe('format', () => {
        it('formats report with changes and devMode indicator', () => {
            const html = task.format({
                devMode: true,
                details: {
                    changed: [{ id: 's1' }],
                    totalPending: 5,
                    alreadySet: 10
                }
            });

            expect(html).toContain('1/5 E-Mail-Adressen gesetzt');
            expect(html).toContain('[DEV MODE LIMIT]');
        });

        it('formats report when all emails are already up to date', () => {
            const html = task.format({
                devMode: false,
                details: {
                    changed: [],
                    totalPending: 0,
                    alreadySet: 42
                }
            });

            expect(html).toContain('Alle E-Mail-Adressen aktuell (42)');
        });

        it('formats report with error count', () => {
            const html = task.format({
                devMode: false,
                details: {
                    changed: [],
                    totalPending: 2,
                    alreadySet: 10,
                    errors: [{ id: 's1', message: 'err' }]
                }
            });

            expect(html).toContain('1 Fehler');
        });
    });
});
