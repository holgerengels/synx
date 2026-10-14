const WebUntisGroupSyncTask = require('../../src/students/tasks/WebUntisGroupSyncTask');
const devModeUtils = require('../../src/utils/devMode');
const config = require('../../src/config');
const { getDomain } = require('../../src/domains/registry');

jest.mock('../../src/domains/registry', () => ({
    getDomain: jest.fn()
}));

describe('WebUntisGroupSyncTask', () => {
    let task;
    let mockUntis;

    beforeEach(() => {
        task = new WebUntisGroupSyncTask();
        jest.restoreAllMocks();

        config.webuntisRoles = {
            adultGroup: 'Schüler*innen Ü18',
            defaultGroup: 'Schüler*innen',
            ignoredStudents: ['ignored.user']
        };

        mockUntis = {
            readIdentities: jest.fn(),
            readUserGroups: jest.fn().mockResolvedValue([
                { id: 29, name: 'Schüler*innen Ü18' },
                { id: 5, name: 'Schüler*innen' }
            ]),
            readUserGroup: jest.fn().mockImplementation((id) => {
                if (id === 29) {
                    return Promise.resolve({
                        id: 29,
                        name: 'Schüler*innen Ü18',
                        memberIds: [],
                        options: [
                            { id: 101, label: 'adult.noduty', role: 5 },
                            { id: 102, label: 'adult.withduty', role: 5 },
                            { id: 103, label: 'minor.user', role: 5 },
                            { id: 104, label: 'ignored.user', role: 5 }
                        ],
                        fields: [['id', '29']]
                    });
                }
                return Promise.resolve({
                    id: 5,
                    name: 'Schüler*innen',
                    memberIds: [102, 103],
                    options: [
                        { id: 101, label: 'adult.noduty', role: 5 },
                        { id: 102, label: 'adult.withduty', role: 5 },
                        { id: 103, label: 'minor.user', role: 5 },
                        { id: 104, label: 'ignored.user', role: 5 }
                    ],
                    fields: [['id', '5']]
                });
            }),
            writeUserGroupMembers: jest.fn().mockResolvedValue({ status: 200 })
        };

        getDomain.mockReturnValue(mockUntis);
    });

    it('classifies students and adds adult students without Attestpflicht to Ü18 group', async () => {
        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(false);

        mockUntis.readIdentities.mockResolvedValue([
            // 20 years old, no duty -> belongs to Ü18
            { userId: 'adult.noduty', birthday: '2004-01-01', medicalReportDuty: false },
            // 20 years old, has duty -> belongs to default
            { userId: 'adult.withduty', birthday: '2004-01-01', medicalReportDuty: true },
            // 15 years old -> belongs to default
            { userId: 'minor.user', birthday: '2011-01-01', medicalReportDuty: false },
            // Ignored
            { userId: 'ignored.user', birthday: '2000-01-01', medicalReportDuty: false },
            // _OLD suffix
            { userId: 'old.user_OLD', birthday: '2000-01-01', medicalReportDuty: false }
        ]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.totalStudents).toBe(5);
        expect(result.details.adultCount).toBe(1);
        expect(result.details.defaultCount).toBe(2);

        // writeUserGroupMembers should be called for Ü18 group to add adult.noduty (ID 101)
        expect(mockUntis.writeUserGroupMembers).toHaveBeenCalledWith(
            expect.objectContaining({ id: 29 }),
            [101]
        );
    });

    it('respects DevMode limit: maximum 1 change when devMode is active', async () => {
        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(true);

        // Two adults needing to be added
        mockUntis.readUserGroup.mockImplementation((id) => {
            if (id === 29) {
                return Promise.resolve({
                    id: 29,
                    name: 'Schüler*innen Ü18',
                    memberIds: [],
                    options: [
                        { id: 101, label: 'adult.one', role: 5 },
                        { id: 102, label: 'adult.two', role: 5 }
                    ],
                    fields: [['id', '29']]
                });
            }
            return Promise.resolve({
                id: 5,
                name: 'Schüler*innen',
                memberIds: [],
                options: [
                    { id: 101, label: 'adult.one', role: 5 },
                    { id: 102, label: 'adult.two', role: 5 }
                ],
                fields: [['id', '5']]
            });
        });

        mockUntis.readIdentities.mockResolvedValue([
            { userId: 'adult.one', birthday: '2000-01-01', medicalReportDuty: false },
            { userId: 'adult.two', birthday: '2000-01-01', medicalReportDuty: false }
        ]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.devMode).toBe(true);
        expect(result.details.limited).toBe(true);
        expect(result.details.adultGroup.pending).toBe(2);
        expect(result.details.adultGroup.written).toBe(1);

        // Exactly 1 student written
        expect(mockUntis.writeUserGroupMembers).toHaveBeenCalledWith(
            expect.objectContaining({ id: 29 }),
            [101]
        );
    });

    it('does not write when groups are already in sync', async () => {
        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(false);

        mockUntis.readIdentities.mockResolvedValue([
            { userId: 'adult.noduty', birthday: '2000-01-01', medicalReportDuty: false }
        ]);

        // Adult already in Ü18 group
        mockUntis.readUserGroup.mockImplementation((id) => {
            if (id === 29) {
                return Promise.resolve({
                    id: 29,
                    name: 'Schüler*innen Ü18',
                    memberIds: [101],
                    options: [{ id: 101, label: 'adult.noduty', role: 5 }],
                    fields: [['id', '29']]
                });
            }
            return Promise.resolve({
                id: 5,
                name: 'Schüler*innen',
                memberIds: [],
                options: [{ id: 101, label: 'adult.noduty', role: 5 }],
                fields: [['id', '5']]
            });
        });

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.adultGroup.pending).toBe(0);
        expect(result.details.adultGroup.written).toBe(0);
        expect(mockUntis.writeUserGroupMembers).not.toHaveBeenCalled();

        const html = task.format(result);
        expect(html).toContain('bereits synchron');
    });
});
