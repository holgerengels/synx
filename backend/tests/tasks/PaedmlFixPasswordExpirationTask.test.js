const EventEmitter = require('events');

// Setup mock config before requiring task
jest.mock('../../src/config', () => ({
    ldap: {
        url: 'ldaps://mock-dc01:636',
        user: 'cn=Administrator,dc=test',
        password: 'secretpassword',
        studentUserbase: 'OU=Students,DC=test'
    },
    settings: {
        devMode: false
    }
}));

// Mock ldapjs
const mockSend = jest.fn();
const mockSearchEntries = [
    {
        objectName: 'CN=student1,OU=Students,DC=test',
        object: {
            sAMAccountName: 'student1',
            cn: 'student1',
            userAccountControl: '512', // Expires
            accountExpires: '0'
        }
    },
    {
        objectName: 'CN=student2,OU=Students,DC=test',
        object: {
            sAMAccountName: 'student2',
            cn: 'student2',
            userAccountControl: '66048', // 512 | 0x10000 -> Already never expires
            accountExpires: '0'
        }
    },
    {
        objectName: 'CN=student3,OU=Students,DC=test',
        object: {
            sAMAccountName: 'student3',
            cn: 'student3',
            userAccountControl: '512', // Expires
            accountExpires: '133000000000000000' // Also has account expiration
        }
    }
];

jest.mock('ldapjs', () => {
    class Change {
        constructor(opts) {
            this.operation = opts.operation;
            this.modification = opts.modification;
        }
    }
    class ModifyRequest {
        constructor() {
            this.object = '';
            this.changes = [];
        }
    }
    class LDAPResult {}

    return {
        Change,
        ModifyRequest,
        LDAPResult,
        createClient: jest.fn(() => {
            const client = {
                on: jest.fn(),
                bind: jest.fn((dn, pw, cb) => cb(null)),
                search: jest.fn((base, opts, cb) => {
                    const EventEmitter = require('events');
                    const searchRes = new EventEmitter();
                    process.nextTick(() => {
                        for (const entry of mockSearchEntries) {
                            searchRes.emit('searchEntry', entry);
                        }
                        searchRes.emit('end');
                    });
                    cb(null, searchRes);
                }),
                _send: jest.fn((req, resArr, nullArg, cb) => {
                    mockSend(req);
                    cb(null);
                }),
                unbind: jest.fn()
            };
            return client;
        })
    };
});

const PaedmlFixPasswordExpirationTask = require('../../src/students/tasks/PaedmlFixPasswordExpirationTask');

describe('PaedmlFixPasswordExpirationTask', () => {
    let task;

    beforeEach(() => {
        task = new PaedmlFixPasswordExpirationTask();
        mockSend.mockClear();
    });

    test('correctly identifies expiring accounts and updates them', async () => {
        const result = await task.execute();

        expect(result.success).toBe(true);
        expect(result.details.totalStudents).toBe(3);
        expect(result.details.alreadyNeverExpires).toBe(1); // student2
        expect(result.details.totalPending).toBe(2); // student1 and student3
        expect(result.details.changed).toHaveLength(2);

        // student1 should have userAccountControl updated to 66048
        const s1Change = result.details.changed.find(c => c.id === 'student1');
        expect(s1Change).toBeDefined();
        expect(s1Change.new.userAccountControl).toBe('66048');

        // student3 should have userAccountControl 66048 and accountExpires '0'
        const s3Change = result.details.changed.find(c => c.id === 'student3');
        expect(s3Change).toBeDefined();
        expect(s3Change.new.userAccountControl).toBe('66048');
        expect(s3Change.new.accountExpires).toBe('0');

        // Check that mockSend was called twice (once for student1, once for student3)
        expect(mockSend).toHaveBeenCalledTimes(2);
    });

    test('respects devMode write limit', async () => {
        const config = require('../../src/config');
        config.settings.devMode = true;

        const result = await task.execute();
        expect(result.success).toBe(true);
        expect(result.devMode).toBe(true);
        expect(result.details.totalPending).toBe(2);
        // In dev mode, only 1 entry is updated
        expect(result.details.changed).toHaveLength(1);
        expect(result.details.skipped).toBe(1);
        expect(mockSend).toHaveBeenCalledTimes(1);

        config.settings.devMode = false;
    });

    test('format produces correct HTML messages', () => {
        // Cases:
        // 1. Pending changes applied
        const reportSuccess = {
            devMode: false,
            details: {
                totalStudents: 3,
                alreadyNeverExpires: 1,
                totalPending: 2,
                changed: [{ id: 'student1' }, { id: 'student3' }]
            }
        };
        const html1 = task.format(reportSuccess);
        expect(html1).toContain('2/2 Kennwortablauf aufgehoben');

        // 2. All accounts already without expiration
        const reportAllCurrent = {
            devMode: false,
            details: {
                totalStudents: 3,
                alreadyNeverExpires: 3,
                totalPending: 0,
                changed: []
            }
        };
        const html2 = task.format(reportAllCurrent);
        expect(html2).toContain('Alle Kennwörter ohne Ablaufdatum (3)');

        // 3. Null / empty report
        expect(task.format(null)).toBe('-');
    });
});
