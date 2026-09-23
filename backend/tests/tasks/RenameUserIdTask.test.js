const RenameUserIdTask = require('../../src/students/tasks/RenameUserIdTask');
const { createMockDomains } = require('../helpers/mockSetup');
const devModeUtil = require('../../src/utils/devMode');

describe('RenameUserIdTask', () => {
    let task;
    let mocks;

    beforeEach(() => {
        task = new RenameUserIdTask();
        mocks = createMockDomains();
        mocks.asv.renameIdentity = jest.fn().mockResolvedValue({ success: true, oldUserId: 'mueller.max', newUserId: 'meier.max' });
        mocks.untis.hasActiveClients = jest.fn().mockResolvedValue({ active: false, count: 0 });
        mocks.untis.renameIdentity = jest.fn().mockResolvedValue({ success: true, oldUserId: 'mueller.max', newUserId: 'meier.max', affectedRows: 1 });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Validation', () => {
        test('throws if parameters are missing', async () => {
            await expect(task.execute()).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
            await expect(task.execute({ oldUserId: 'old.user' })).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
            await expect(task.execute({ newUserId: 'new.user' })).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
            await expect(task.execute({ oldUserId: '   ', newUserId: 'new.user' })).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
        });

        test('throws if old and new IDs are identical', async () => {
            await expect(task.execute({ oldUserId: 'same.user', newUserId: 'same.user' })).rejects.toThrow(
                'Alte und neue User-ID dürfen nicht identisch sein.'
            );
        });
    });

    describe('Active Untis Clients Check', () => {
        test('fails when Untis has active clients logged in', async () => {
            mocks.untis.hasActiveClients.mockResolvedValueOnce({ active: true, count: 3 });

            await expect(task.execute({ oldUserId: 'mueller.max', newUserId: 'meier.max' })).rejects.toThrow(
                'Untis hat noch aktive Verbindungen (3 Client(s) eingeloggt). Bitte Untis zuerst schließen.'
            );

            expect(mocks.asv.renameIdentity).not.toHaveBeenCalled();
            expect(mocks.untis.renameIdentity).not.toHaveBeenCalled();
        });
    });

    describe('DevMode (Dry Run)', () => {
        test('does not perform real renames in DevMode', async () => {
            jest.spyOn(devModeUtil, 'isDevMode').mockReturnValue(true);

            const result = await task.execute({ oldUserId: 'mueller.max', newUserId: 'meier.max' });

            expect(result.success).toBe(true);
            expect(result.devMode).toBe(true);
            expect(result.dryRun).toBe(true);
            expect(result.oldUserId).toBe('mueller.max');
            expect(result.newUserId).toBe('meier.max');
            expect(result.warnings.length).toBe(4);

            expect(mocks.asv.renameIdentity).not.toHaveBeenCalled();
            expect(mocks.untis.renameIdentity).not.toHaveBeenCalled();
        });
    });

    describe('Production Execution', () => {
        test('executes rename on ASV and Untis sequentially when not in DevMode', async () => {
            jest.spyOn(devModeUtil, 'isDevMode').mockReturnValue(false);

            const result = await task.execute({ oldUserId: 'mueller.max', newUserId: 'meier.max' });

            expect(result.success).toBe(true);
            expect(result.devMode).toBe(false);
            expect(mocks.asv.renameIdentity).toHaveBeenCalledWith('mueller.max', 'meier.max');
            expect(mocks.untis.renameIdentity).toHaveBeenCalledWith('mueller.max', 'meier.max');
            expect(result.details.changed[0]).toEqual({
                id: 'mueller.max',
                old: { userId: 'mueller.max' },
                new: { userId: 'meier.max' }
            });
        });
    });

    describe('Format and Reporting', () => {
        test('formats successful report with all warnings and links', () => {
            const report = {
                success: true,
                devMode: false,
                oldUserId: 'mueller.max',
                newUserId: 'meier.max'
            };

            const html = task.format(report);

            expect(html).toContain('mueller.max');
            expect(html).toContain('meier.max');
            expect(html).toContain('ASV:');
            expect(html).toContain('Untis:');
            expect(html).toContain('WebUntis:');
            expect(html).toContain('Schulkonsole:');
            expect(html).toContain('Nextcloud:');
            expect(html).toContain('Matrix:');
            expect(html).not.toContain('(DevMode: Dry-Run)');
        });

        test('formats devMode report with dry-run indicator', () => {
            const report = {
                success: true,
                devMode: true,
                oldUserId: 'mueller.max',
                newUserId: 'meier.max'
            };

            const html = task.format(report);

            expect(html).toContain('(DevMode: Dry-Run)');
        });

        test('formats error report', () => {
            const html = task.format({ success: false, error: 'DB locked' });
            expect(html).toContain('Fehler: DB locked');
        });

        test('handles null report gracefully', () => {
            expect(task.format(null)).toBe('-');
        });
    });
});
