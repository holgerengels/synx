const ManagableDomain = require('../../src/domains/ManagableDomain');

describe('ManagableDomain', () => {
    let domain;

    beforeEach(() => {
        domain = new ManagableDomain('test-managable');
    });

    test('addIdentity throws NotImplementedError', async () => {
        await expect(domain.addIdentity({ userId: 'u1' })).rejects.toThrow(
            "[ManagableDomain] addIdentity() is not implemented for domain 'test-managable'"
        );
    });

    test('changeIdentity throws NotImplementedError', async () => {
        await expect(domain.changeIdentity({ userId: 'u1' })).rejects.toThrow(
            "[ManagableDomain] changeIdentity() is not implemented for domain 'test-managable'"
        );
    });

    test('removeIdentity throws NotImplementedError', async () => {
        await expect(domain.removeIdentity({ userId: 'u1' })).rejects.toThrow(
            "[ManagableDomain] removeIdentity() is not implemented for domain 'test-managable'"
        );
    });

    test('renameIdentity throws NotImplementedError', async () => {
        await expect(domain.renameIdentity('old.id', 'new.id')).rejects.toThrow(
            "[ManagableDomain] renameIdentity() is not implemented for domain 'test-managable'"
        );
    });
});
