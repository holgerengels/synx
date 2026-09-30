process.env.JWT_SECRET = 'test_secret';
process.env.REFRESH_JWT_SECRET = 'test_refresh_secret';

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

// Mock ldapjs
jest.mock('ldapjs', () => ({
    createClient: jest.fn(() => ({
        on: jest.fn(),
        bind: jest.fn(),
        search: jest.fn(),
        unbind: jest.fn()
    }))
}));

// Mock config
jest.mock('../src/config', () => ({
    settings: { devMode: true },
    categories: [],
    domains: [],
    diffs: [],
    tasks: [{ name: 'scheduled-task', schedule: '0 2 * * *' }]
}));

// Mock domains registry
jest.mock('../src/domains/registry', () => ({
    getDomain: jest.fn(),
    getAllDomains: jest.fn(() => ({})),
    registerDomain: jest.fn(),
    clearRegistry: jest.fn()
}));

// Mock Log model
const mockFind = jest.fn();
const mockSort = jest.fn();
const mockSkip = jest.fn();
const mockLimit = jest.fn();
const mockCountDocuments = jest.fn();
const mockDistinct = jest.fn();

mockFind.mockReturnValue({
    sort: mockSort.mockReturnValue({
        skip: mockSkip.mockReturnValue({
            limit: mockLimit
        })
    })
});

jest.mock('../src/models/Log', () => ({
    find: mockFind,
    countDocuments: mockCountDocuments,
    distinct: mockDistinct
}));

// Mock tasks registry
jest.mock('../src/tasks', () => ({
    'registered-task-1': {},
    'registered-task-2': {}
}));

const routes = require('../src/routes');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', routes);
    return app;
}

function validToken() {
    return jwt.sign({ username: 'testadmin', groups: ['Admins'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Logs Routes', () => {
    let app;
    const token = validToken();

    beforeAll(() => {
        app = createTestApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockFind.mockReturnValue({
            sort: mockSort.mockReturnValue({
                skip: mockSkip.mockReturnValue({
                    limit: mockLimit
                })
            })
        });
    });

    describe('GET /api/logs/tasks', () => {
        it('requires authentication', async () => {
            const res = await request(app).get('/api/logs/tasks');
            expect(res.status).toBe(401);
        });

        it('returns combined distinct tasks from Log, registry, and config', async () => {
            mockDistinct.mockResolvedValue(['logged-task-a', 'logged-task-b']);
            const res = await request(app)
                .get('/api/logs/tasks')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body).toContain('logged-task-a');
            expect(res.body).toContain('logged-task-b');
            expect(res.body).toContain('registered-task-1');
            expect(res.body).toContain('scheduled-task');
        });
    });

    describe('GET /api/logs', () => {
        it('requires authentication', async () => {
            const res = await request(app).get('/api/logs');
            expect(res.status).toBe(401);
        });

        it('returns paginated logs with default parameters', async () => {
            mockCountDocuments.mockResolvedValue(100);
            mockLimit.mockResolvedValue([{ _id: '1', task: 'test-task', trigger: 'CRON', status: 'SUCCESS' }]);

            const res = await request(app)
                .get('/api/logs')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(100);
            expect(res.body.page).toBe(1);
            expect(res.body.limit).toBe(50);
            expect(res.body.pages).toBe(2);
            expect(mockFind).toHaveBeenCalledWith({});
        });

        it('filters by task, trigger, and status', async () => {
            mockCountDocuments.mockResolvedValue(5);
            mockLimit.mockResolvedValue([]);

            const res = await request(app)
                .get('/api/logs?task=my-task&trigger=CRON&status=SUCCESS')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(mockCountDocuments).toHaveBeenCalledWith({
                task: 'my-task',
                trigger: 'CRON',
                status: 'SUCCESS'
            });
            expect(mockFind).toHaveBeenCalledWith({
                task: 'my-task',
                trigger: 'CRON',
                status: 'SUCCESS'
            });
        });

        it('filters by search keyword in task and summaryHtml', async () => {
            mockCountDocuments.mockResolvedValue(1);
            mockLimit.mockResolvedValue([]);

            const res = await request(app)
                .get('/api/logs?search=test')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            const queryArg = mockFind.mock.calls[0][0];
            expect(queryArg.$or).toBeDefined();
            expect(queryArg.$or).toHaveLength(2);
        });
    });
});
