process.env.JWT_SECRET = 'test_secret';
process.env.REFRESH_JWT_SECRET = 'test_refresh_secret';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');

// Mock ldapjs
jest.mock('ldapjs', () => ({
    createClient: jest.fn(() => ({
        on: jest.fn(),
        bind: jest.fn(),
        search: jest.fn(),
        unbind: jest.fn()
    }))
}));

// Mock logger to avoid connecting to MongoDB during unit test
jest.mock('../../src/utils/logger', () => ({
    startTask: jest.fn().mockResolvedValue('mock-log-id'),
    endTask: jest.fn().mockResolvedValue(),
    logDirect: jest.fn().mockResolvedValue()
}));

// Mock config
jest.mock('../../src/config', () => ({
    settings: { devMode: true },
    categories: [],
    domains: [],
    diffs: [],
    tasks: []
}));

const mockUntis = {
    hasActiveClients: jest.fn().mockResolvedValue({ active: false, count: 0 })
};

jest.mock('../../src/domains/registry', () => ({
    getDomain: jest.fn((name) => {
        if (name === 'untis') return mockUntis;
        return null;
    }),
    getAllDomains: jest.fn(() => ({ untis: mockUntis })),
    registerDomain: jest.fn(),
    clearRegistry: jest.fn()
}));

const routes = require('../../src/routes');

const app = express();
app.use(bodyParser.json());
app.use('/api', routes);

function makeToken() {
    return jwt.sign(
        { username: 'admin', groups: ['Admins'] },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );
}

describe('Rename Workflow API Integration', () => {
    const token = makeToken();

    describe('GET /api/untis/active-clients', () => {
        test('returns active clients status with valid token', async () => {
            mockUntis.hasActiveClients.mockResolvedValueOnce({ active: false, count: 0 });

            const res = await request(app)
                .get('/api/untis/active-clients')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ active: false, count: 0 });
        });

        test('returns active: true when clients are logged in', async () => {
            mockUntis.hasActiveClients.mockResolvedValueOnce({ active: true, count: 2 });

            const res = await request(app)
                .get('/api/untis/active-clients')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ active: true, count: 2 });
        });

        test('returns 401 without auth token', async () => {
            const res = await request(app).get('/api/untis/active-clients');
            expect(res.status).toBe(401);
        });
    });

    describe('POST /api/execute/rename-userid', () => {
        test('executes rename-userid task in dry-run devMode', async () => {
            const res = await request(app)
                .post('/api/execute/rename-userid')
                .set('Authorization', `Bearer ${token}`)
                .send({ oldUserId: 'test.alt', newUserId: 'test.neu' });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('success');
            expect(res.body.report.success).toBe(true);
            expect(res.body.report.devMode).toBe(true);
            expect(res.body.report.oldUserId).toBe('test.alt');
            expect(res.body.report.newUserId).toBe('test.neu');
            expect(res.body.html).toContain('test.alt');
            expect(res.body.html).toContain('test.neu');
        });

        test('fails when parameters are missing', async () => {
            const res = await request(app)
                .post('/api/execute/rename-userid')
                .set('Authorization', `Bearer ${token}`)
                .send({});

            expect(res.status).toBe(500);
            expect(res.body.error).toContain('Alte und neue User-ID müssen angegeben werden.');
        });
    });
});
