const WebUntisClassregCleanupTask = require('../../src/students/tasks/WebUntisClassregCleanupTask');
const devModeUtils = require('../../src/utils/devMode');
const config = require('../../src/config');
const { getDomain } = require('../../src/domains/registry');

jest.mock('../../src/domains/registry', () => ({
    getDomain: jest.fn()
}));

function makePeriod({ id, lsId = 100, classId = 7, date = '2026-10-15', teachers = ['o.L.'], topicShort = null, absChecked = false, absCheckNeeded = true }) {
    return {
        period: {
            id,
            lsId,
            dtRange: { start: `${date}T07:50:00`, end: `${date}T08:35:00` },
            classes: [{ el: { id: classId, name: 'TG11' } }],
            teachers: teachers.map((t, idx) => ({ el: { id: idx, name: t, nameShort: t } }))
        },
        topicId: topicShort ? 999 : null,
        topicShort,
        topicNeeded: true,
        absCheckNeeded,
        absChecked
    };
}

describe('WebUntisClassregCleanupTask', () => {
    let task;
    let mockUntis;

    beforeEach(() => {
        task = new WebUntisClassregCleanupTask();
        jest.restoreAllMocks();

        config.settings = { devMode: false };
        config.webuntisRoles = {
            classregCategories: '!!;o.L.;kein L.;LB;---',
            topicText: '---'
        };

        mockUntis = {
            readSchoolYearRange: jest.fn().mockResolvedValue({ start: '2026-09-14', end: '2026-10-15' }),
            readOpenPeriods: jest.fn(),
            writeLessonTopic: jest.fn().mockResolvedValue([{ id: 1001, periodId: 1, text: '---' }]),
            markAbsencesChecked: jest.fn().mockResolvedValue([1])
        };

        getDomain.mockReturnValue(mockUntis);
    });

    it('classifies periods, ignores mixed and real teachers, and closes eligible blocks', async () => {
        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(false);

        // Period 1 & 2: Same lesson, class, date -> single block with placeholder 'o.L.'
        // Period 3: Single period with 'kein L.'
        // Period 4: Mixed teacher ('---', 'schmitt') -> skipped
        // Period 5: Real teacher ('mueller') -> ignored
        mockUntis.readOpenPeriods.mockResolvedValue([
            makePeriod({ id: 1, lsId: 100, teachers: ['o.L.'] }),
            makePeriod({ id: 2, lsId: 100, teachers: ['o.L.'] }),
            makePeriod({ id: 3, lsId: 200, teachers: ['kein L.'] }),
            makePeriod({ id: 4, lsId: 300, teachers: ['---', 'schmitt'] }),
            makePeriod({ id: 5, lsId: 400, teachers: ['mueller'] })
        ]);

        mockUntis.writeLessonTopic
            .mockResolvedValueOnce([{ periodId: 1 }, { periodId: 2 }])
            .mockResolvedValueOnce([{ periodId: 3 }]);
        mockUntis.markAbsencesChecked
            .mockResolvedValueOnce([1, 2])
            .mockResolvedValueOnce([3]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.openTotal).toBe(5);
        expect(result.details.eligiblePeriods).toBe(3);
        expect(result.details.mixedTotal).toBe(1);
        expect(result.details.done).toBe(2); // 2 blocks closed
        expect(result.details.closedPeriodsCount).toBe(3); // 3 periods total in those 2 blocks

        // Block 1 (periods 1 & 2): anchor is 1
        expect(mockUntis.writeLessonTopic).toHaveBeenCalledWith(1, '---');
        expect(mockUntis.markAbsencesChecked).toHaveBeenCalledWith(1);

        // Block 2 (period 3): anchor is 3
        expect(mockUntis.writeLessonTopic).toHaveBeenCalledWith(3, '---');
        expect(mockUntis.markAbsencesChecked).toHaveBeenCalledWith(3);

        const formatted = task.format(result);
        expect(formatted).toContain('2 Block/Blöcke (3 Std.) geschlossen');
        expect(formatted).toContain('1 Std. mit echter Lehrkraft übersprungen');
    });

    it('respects DevMode limit: maximum 1 block processed when devMode is active', async () => {
        config.settings = { devMode: true };
        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(true);

        mockUntis.readOpenPeriods.mockResolvedValue([
            makePeriod({ id: 1, lsId: 100, teachers: ['o.L.'] }),
            makePeriod({ id: 2, lsId: 200, teachers: ['kein L.'] })
        ]);

        mockUntis.writeLessonTopic.mockResolvedValueOnce([{ periodId: 1 }]);
        mockUntis.markAbsencesChecked.mockResolvedValueOnce([1]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.actionableBlocks).toBe(2);
        expect(result.details.done).toBe(1);
        expect(result.details.limited).toBe(true);

        // Only block 1 was touched
        expect(mockUntis.writeLessonTopic).toHaveBeenCalledTimes(1);
        expect(mockUntis.writeLessonTopic).toHaveBeenCalledWith(1, '---');

        const formatted = task.format(result);
        expect(formatted).toContain('DevMode Limit: 1');
    });

    it('handles empty open periods gracefully', async () => {
        jest.spyOn(devModeUtils, 'isDevMode').mockReturnValue(false);

        mockUntis.readOpenPeriods.mockResolvedValue([]);

        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.actionableBlocks).toBe(0);
        expect(result.details.done).toBe(0);

        expect(mockUntis.writeLessonTopic).not.toHaveBeenCalled();
        expect(mockUntis.markAbsencesChecked).not.toHaveBeenCalled();

        const formatted = task.format(result);
        expect(formatted).toContain('Keine offenen Stunden ohne Lehrkraft');
    });
});
