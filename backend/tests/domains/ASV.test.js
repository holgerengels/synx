jest.mock('../../src/config', () => ({
    asv: {
        host: 'localhost',
        port: 5432,
        name: 'testdb',
        user: 'testuser',
        password: 'testpassword',
        schuljahr: '2026/27',
        lag: '30 days'
    }
}));

const asv = require('../../src/students/domains/ASV');

describe('ASV Domain - renameIdentity', () => {
    let mockClient;

    beforeEach(() => {
        mockClient = {
            query: jest.fn(),
            release: jest.fn()
        };
        jest.spyOn(asv.pool, 'connect').mockResolvedValue(mockClient);
        jest.spyOn(asv, 'invalidate').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('throws if arguments are missing', async () => {
        await expect(asv.renameIdentity()).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
        await expect(asv.renameIdentity('old.id', '')).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
        await expect(asv.renameIdentity('', 'new.id')).rejects.toThrow('Alte und neue User-ID müssen angegeben werden.');
    });

    test('throws if oldUserId and newUserId are identical', async () => {
        await expect(asv.renameIdentity('same.id', 'same.id')).rejects.toThrow('Alte und neue User-ID dürfen nicht identisch sein.');
    });

    test('throws if oldUserId does not exist in ASV', async () => {
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        await expect(asv.renameIdentity('nonexistent.user', 'new.user')).rejects.toThrow(
            "User-ID 'nonexistent.user' existiert nicht in ASV."
        );

        expect(mockClient.release).toHaveBeenCalled();
    });

    test('throws if newUserId is already taken in ASV', async () => {
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: '123', userid: 'old.user' }] });
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: '456', userid: 'new.user' }] });

        await expect(asv.renameIdentity('old.user', 'new.user')).rejects.toThrow(
            "User-ID 'new.user' ist in ASV bereits vergeben."
        );

        expect(mockClient.release).toHaveBeenCalled();
    });

    test('successfully updates sync.user_id and invalidates cache', async () => {
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: '123', userid: 'old.user' }] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rowCount: 1 });

        const result = await asv.renameIdentity('old.user', 'new.user');

        expect(result).toEqual({
            success: true,
            oldUserId: 'old.user',
            newUserId: 'new.user'
        });

        expect(mockClient.query).toHaveBeenNthCalledWith(
            3,
            'UPDATE sync.user_id SET userid = $1 WHERE userid = $2',
            ['new.user', 'old.user']
        );

        expect(asv.invalidate).toHaveBeenCalled();
        expect(mockClient.release).toHaveBeenCalled();
    });
});
