jest.mock('../../src/config', () => ({
    untis: {
        host: 'localhost',
        port: 3306,
        name: 'testdb',
        user: 'testuser',
        password: 'testpassword',
        schulid: 1,
        version: 1,
        schuljahr: 20262027
    }
}));

const untis = require('../../src/students/domains/Untis');
const mysql = require('mysql2/promise');

describe('Untis Domain - hasActiveClients & renameIdentity', () => {
    let mockConnection;

    beforeEach(() => {
        mockConnection = {
            execute: jest.fn(),
            end: jest.fn().mockResolvedValue()
        };
        jest.spyOn(mysql, 'createConnection').mockResolvedValue(mockConnection);
        jest.spyOn(untis, 'invalidate').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('hasActiveClients', () => {
        test('returns active: false and empty sessions when 0 clients are logged in', async () => {
            mockConnection.execute.mockResolvedValueOnce([[]]);

            const result = await untis.hasActiveClients();

            expect(result).toEqual({ active: false, count: 0, sessions: [] });
            expect(mockConnection.execute).toHaveBeenCalledWith(
                'SELECT USER_ID, Name, UserInfo, LogInDate, LogInTime FROM User WHERE LoggedIn = 1'
            );
            expect(mockConnection.end).toHaveBeenCalled();
        });

        test('returns active: true with parsed sessions when clients are logged in', async () => {
            mockConnection.execute.mockResolvedValueOnce([[
                { USER_ID: 3, Name: 'BK', UserInfo: 'Apr 8 2026~0~V205P01W11~Irmgard.Hain~2026.7.0\0', LogInDate: 20260923, LogInTime: 1304 },
                { USER_ID: 4, Name: 'Stundenplan', UserInfo: 'Apr 8 2026~0~V307P03~stunden.plan~2026.7.0\0', LogInDate: 20260923, LogInTime: 1251 }
            ]]);

            const result = await untis.hasActiveClients();

            expect(result).toEqual({
                active: true,
                count: 2,
                sessions: [
                    { user: 'BK', workstation: 'V205P01W11', osUser: 'Irmgard.Hain', loginAt: '23.09.2026 13:04' },
                    { user: 'Stundenplan', workstation: 'V307P03', osUser: 'stunden.plan', loginAt: '23.09.2026 12:51' }
                ]
            });
            expect(mockConnection.end).toHaveBeenCalled();
        });
    });

    describe('renameIdentity', () => {
        test('throws if arguments are missing or identical', async () => {
            await expect(untis.renameIdentity()).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
            await expect(untis.renameIdentity('old.id', '')).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
            await expect(untis.renameIdentity('same.id', 'same.id')).rejects.toThrow('Alte und neue User-ID dürfen nicht identisch sein.');
        });

        test('throws if student with oldUserId does not exist in Untis', async () => {
            mockConnection.execute.mockResolvedValueOnce([[{ cnt: 0 }]]);

            await expect(untis.renameIdentity('unknown.user', 'new.user')).rejects.toThrow(
                "Schüler:in mit Name 'unknown.user' existiert nicht in Untis."
            );
            expect(mockConnection.end).toHaveBeenCalled();
        });

        test('throws if student with newUserId already exists in Untis (collision)', async () => {
            mockConnection.execute.mockResolvedValueOnce([[{ cnt: 1 }]]);
            mockConnection.execute.mockResolvedValueOnce([[{ cnt: 1 }]]);

            await expect(untis.renameIdentity('old.user', 'new.user')).rejects.toThrow(
                "Schüler:in mit Name 'new.user' existiert bereits in Untis."
            );
            expect(mockConnection.end).toHaveBeenCalled();
        });

        test('successfully updates Name, ForeignKey and OldName in Student table', async () => {
            mockConnection.execute.mockResolvedValueOnce([[{ cnt: 1 }]]);
            mockConnection.execute.mockResolvedValueOnce([[{ cnt: 0 }]]);
            mockConnection.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

            const result = await untis.renameIdentity('old.user', 'new.user');

            expect(result).toEqual({
                success: true,
                oldUserId: 'old.user',
                newUserId: 'new.user',
                affectedRows: 1
            });

            expect(mockConnection.execute).toHaveBeenNthCalledWith(
                3,
                'UPDATE Student SET Name = ?, ForeignKey = ?, OldName = ? WHERE SCHOOL_ID = ? AND VERSION_ID = ? AND Name = ?',
                ['new.user', 'new.user', 'old.user', untis.schulid, untis.version, 'old.user']
            );

            expect(untis.invalidate).toHaveBeenCalled();
            expect(mockConnection.end).toHaveBeenCalled();
        });
    });
});
