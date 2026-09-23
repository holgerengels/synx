const Domain = require('./Domain');

class NotImplementedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotImplementedError';
    }
}

class ManagableDomain extends Domain {
    constructor(domainName) {
        super(domainName);
    }

    async addIdentity(identity) {
        throw new NotImplementedError(`[ManagableDomain] addIdentity() is not implemented for domain '${this.domainName}'`);
    }

    async changeIdentity(identity) {
        throw new NotImplementedError(`[ManagableDomain] changeIdentity() is not implemented for domain '${this.domainName}'`);
    }

    async removeIdentity(identity) {
        throw new NotImplementedError(`[ManagableDomain] removeIdentity() is not implemented for domain '${this.domainName}'`);
    }

    async renameIdentity(oldUserId, newUserId) {
        throw new NotImplementedError(`[ManagableDomain] renameIdentity() is not implemented for domain '${this.domainName}'`);
    }
}

module.exports = ManagableDomain;
