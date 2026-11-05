const WebUntisGuardianSyncTask = require('../../src/students/tasks/WebUntisGuardianSyncTask');
const devModeUtils = require('../../src/utils/devMode');
const { getDomain } = require('../../src/domains/registry');

jest.mock('../../src/domains/registry', () => ({
    getDomain: jest.fn()
}));

describe('WebUntisGuardianSyncTask', () => {
    let task;
    let mockAsv;
    let mockUntis;

    beforeEach(() => {
        task = new WebUntisGuardianSyncTask();
        jest.restoreAllMocks();

        mockAsv = {
            readGuardians: jest.fn()
        };
        mockUntis = {
            readGuardians: jest.fn(),
            changeGuardian: jest.fn().mockResolvedValue({ success: true, status: 302 })
        };

        getDomain.mockImplementation(name => {
            if (name === 'asv') return mockAsv;
            if (name === 'webuntis') return mockUntis;
            return null;
        });

        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(false);
    });

    it('ignores null vs empty string for guardian names (prevents false positive updates)', async () => {
        mockAsv.readGuardians.mockResolvedValue([
            {
                id: null,
                email: 'test@example.com',
                firstName: null,
                lastName: null,
                students: [{ account: 'student.one' }]
            }
        ]);

        mockUntis.readGuardians.mockResolvedValue([
            {
                id: '1234',
                email: 'test@example.com',
                firstName: '',
                lastName: '',
                students: [{ account: 'student.one' }]
            }
        ]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.totalAdditionsDiscovered).toBe(0);
        expect(result.details.totalUpdatesDiscovered).toBe(0);
        expect(mockUntis.changeGuardian).not.toHaveBeenCalled();
    });

    it('discovers genuine updates when a name actually changes', async () => {
        mockAsv.readGuardians.mockResolvedValue([
            {
                id: null,
                email: 'parent@example.com',
                firstName: 'Sarah',
                lastName: 'Lock',
                students: [{ account: 'lock.joh' }]
            }
        ]);

        mockUntis.readGuardians.mockResolvedValue([
            {
                id: '2611',
                email: 'parent@example.com',
                firstName: 'Alfons',
                lastName: 'Lock',
                students: [{ account: 'lock.joh' }]
            }
        ]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.totalUpdatesDiscovered).toBe(1);
        expect(mockUntis.changeGuardian).toHaveBeenCalledTimes(1);
        expect(mockUntis.changeGuardian).toHaveBeenCalledWith(
            expect.objectContaining({ id: '2611', firstName: 'Sarah', lastName: 'Lock' }),
            ['lock.joh']
        );
    });

    it('adds new guardians and tracks errors if mutation fails', async () => {
        mockAsv.readGuardians.mockResolvedValue([
            {
                id: null,
                email: 'new@example.com',
                firstName: 'Max',
                lastName: 'Muster',
                students: [{ account: 'muster.max' }]
            }
        ]);
        mockUntis.readGuardians.mockResolvedValue([]);
        mockUntis.changeGuardian.mockRejectedValue(new Error('WebUntis failed'));

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.totalAdditionsDiscovered).toBe(1);
        expect(result.details.added).toHaveLength(0);
        expect(result.details.errors).toHaveLength(1);
        expect(result.details.errors[0].message).toContain('WebUntis failed');
    });
});
