process.env.JWT_SECRET = 'test_secret';
process.env.REFRESH_JWT_SECRET = 'test_refresh_secret';

const jwt = require('jsonwebtoken');
const auth = require('../src/auth');

// Mock ldapjs
jest.mock('ldapjs', () => {
    return {
        createClient: jest.fn(() => ({
            on: jest.fn((event, cb) => {
                // If we want to simulate a connection error
                if (event === 'error' && process.env.MOCK_LDAP_CONN_ERROR === 'true') {
                    setTimeout(() => cb(new Error('Mocked Connection Error')), 10);
                }
            }),
            bind: jest.fn((dn, pw, cb) => {
                if (process.env.MOCK_LDAP_CONN_ERROR === 'true') {
                    return; // Let the error event handle it
                }
                if (process.env.MOCK_LDAP_BIND_ERROR === 'true') {
                    return cb(new Error('Mocked Bind Error'));
                }
                if (pw === 'wrongpassword') {
                    return cb(new Error('Invalid credentials'));
                }
                cb(null);
            }),
            search: jest.fn((base, opts, cb) => {
                if (process.env.MOCK_LDAP_SEARCH_ERROR === 'true') {
                    return cb(new Error('Mocked Search Error'));
                }
                
                const searchRes = {
                    on: jest.fn((event, handler) => {
                        if (event === 'searchEntry') {
                            // Mock returning a user
                            handler({
                                object: {
                                    dn: 'CN=Test User,OU=Users,DC=example,DC=com',
                                    memberOf: ['CN=Lehrer,OU=Groups,DC=example,DC=com'],
                                    givenName: 'Test',
                                    sn: 'User'
                                }
                            });
                        }
                        if (event === 'end') {
                            handler({ status: 0 });
                        }
                    })
                };
                cb(null, searchRes);
            }),
            unbind: jest.fn()
        }))
    };
});

// Mock config
jest.mock('../src/config', () => ({
    settings: {
        devMode: false,
        server: {
            ldap: {
                url: 'ldap://mock',
                binddn: 'admin',
                bindpw: 'secret',
                userfilter: '(objectClass=user)',
                basedn: 'DC=example,DC=com',
                groupprefix: ''
            }
        }
    }
}));

describe('Auth Module', () => {
    beforeAll(() => {
        process.env.JWT_SECRET = 'test_secret';
        process.env.REFRESH_JWT_SECRET = 'test_refresh_secret';
    });

    afterEach(() => {
        delete process.env.MOCK_LDAP_CONN_ERROR;
        delete process.env.MOCK_LDAP_BIND_ERROR;
        delete process.env.MOCK_LDAP_SEARCH_ERROR;
        jest.clearAllMocks();
    });

    describe('login()', () => {
        it('should return null for invalid credentials', async () => {
            const result = await auth.login('testuser', 'wrongpassword');
            expect(result).toBeNull();
        });

        it('should return token and user for valid credentials', async () => {
            const result = await auth.login('testuser', 'correctpassword');
            expect(result).not.toBeNull();
            expect(result.token).toBeDefined();
            expect(result.refreshToken).toBeDefined();
            expect(result.user).toEqual({
                username: 'testuser',
                groups: ['Lehrer'],
                displayName: 'Test User'
            });
        });

        it('should support ldap configuration under settings.ldap', async () => {
            const config = require('../src/config');
            const originalServerLdap = config.settings.server.ldap;
            delete config.settings.server.ldap;
            config.settings.ldap = originalServerLdap;

            try {
                const result = await auth.login('testuser', 'correctpassword');
                expect(result).not.toBeNull();
                expect(result.token).toBeDefined();
            } finally {
                config.settings.server.ldap = originalServerLdap;
                delete config.settings.ldap;
            }
        });

        it('should throw an error on LDAP connection error', async () => {
            process.env.MOCK_LDAP_CONN_ERROR = 'true';
            await expect(auth.login('testuser', 'pw')).rejects.toThrow('LDAP Connection Error: Mocked Connection Error');
        });

        it('should throw an error on LDAP system bind error', async () => {
            process.env.MOCK_LDAP_BIND_ERROR = 'true';
            await expect(auth.login('testuser', 'pw')).rejects.toThrow('LDAP Bind Error (System Account): Mocked Bind Error');
        });
        
        it('should throw an error on LDAP search error', async () => {
            process.env.MOCK_LDAP_SEARCH_ERROR = 'true';
            await expect(auth.login('testuser', 'pw')).rejects.toThrow('LDAP Search Error: Mocked Search Error');
        });
    });

    describe('verifyToken()', () => {
        it('should verify a valid token and call next', () => {
            const token = jwt.sign({ username: 'testuser' }, process.env.JWT_SECRET);
            const req = { headers: { authorization: `Bearer ${token}` } };
            const res = {};
            const next = jest.fn();

            auth.verifyToken(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(req.user.username).toBe('testuser');
        });

        it('should return 401 if no token provided', () => {
            const req = { headers: {} };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const next = jest.fn();

            auth.verifyToken(req, res, next);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ message: 'No token provided' });
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('refreshAccessToken()', () => {
        it('should return new tokens for a valid refresh token', () => {
            const refreshToken = jwt.sign({ username: 'testuser', groups: [], type: 'refresh' }, process.env.REFRESH_JWT_SECRET);
            const result = auth.refreshAccessToken(refreshToken);
            expect(result).not.toBeNull();
            expect(result.token).toBeDefined();
            expect(result.user.username).toBe('testuser');
        });

        it('should return null for an invalid refresh token', () => {
            const result = auth.refreshAccessToken('invalid.token.here');
            expect(result).toBeNull();
        });
    });
});
