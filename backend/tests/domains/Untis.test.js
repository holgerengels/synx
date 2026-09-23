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
        test('returns active: false when 0 clients are logged in', async () => {
            mockConnection.execute.mockResolvedValueOnce([[{ activeCount: 0 }]]);

            const result = await untis.hasActiveClients();

            expect(result).toEqual({ active: false, count: 0 });
            expect(mockConnection.execute).toHaveBeenCalledWith(
                'SELECT COUNT(*) AS activeCount FROM User WHERE LoggedIn = 1'
            );
            expect(mockConnection.end).toHaveBeenCalled();
        });

        test('returns active: true when 1 or more clients are logged in', async () => {
            mockConnection.execute.mockResolvedValueOnce([[{ activeCount: 2 }]]);

            const result = await untis.hasActiveClients();

            expect(result).toEqual({ active: true, count: 2 });
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
