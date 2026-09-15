const Schulkonsole = require('../../src/students/domains/Schulkonsole');
const SchulkonsoleTeacher = require('../../src/teachers/domains/SchulkonsoleTeacher');

describe('Schulkonsole and SchulkonsoleTeacher Re-authentication', () => {
    let originalAdapter;
    let originalTeacherAdapter;

    beforeAll(() => {
        originalAdapter = Schulkonsole.axiosInstance.defaults.adapter;
        originalTeacherAdapter = SchulkonsoleTeacher.axiosInstance.defaults.adapter;
    });

    afterAll(() => {
        Schulkonsole.axiosInstance.defaults.adapter = originalAdapter;
        SchulkonsoleTeacher.axiosInstance.defaults.adapter = originalTeacherAdapter;
    });

    beforeEach(() => {
        // Clear cached auth tokens
        Schulkonsole.authHeader = null;
        Schulkonsole.authTime = 0;
        Schulkonsole.isAuthenticating = false;
        Schulkonsole.classes = {};
        Schulkonsole.studentIds = {};

        SchulkonsoleTeacher.authHeader = null;
        SchulkonsoleTeacher.authTime = 0;
        SchulkonsoleTeacher.isAuthenticating = false;
    });

    it('should retry a failed request once and succeed on student Schulkonsole when 401 is returned', async () => {
        let tokenRequestCount = 0;
        let studentsRequestCount = 0;

        Schulkonsole.axiosInstance.defaults.adapter = jest.fn(async (config) => {
            if (config.url === Schulkonsole.tokenURL) {
                tokenRequestCount++;
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: {
                        token_type: 'Bearer',
                        access_token: `mock-token-${tokenRequestCount}`
                    }
                };
            }

            if (config.url === `${Schulkonsole.apiURL}school/schoolClasses`) {
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: []
                };
            }

            if (config.url === `${Schulkonsole.apiURL}students`) {
                studentsRequestCount++;
                if (studentsRequestCount === 1) {
                    // Fail the first time with 401
                    const err = new Error('Request failed with status code 401');
                    err.response = {
                        status: 401,
                        statusText: 'Unauthorized',
                        headers: {},
                        config,
                        data: { error: 'Invalid token' }
                    };
                    err.config = config;
                    throw err;
                } else {
                    // Succeed the second time
                    return {
                        status: 200,
                        statusText: 'OK',
                        headers: {},
                        config,
                        data: [
                            { id: 1, userName: 'user1', givenName: 'John', surname: 'Doe', schoolClass: '10A' }
                        ]
                    };
                }
            }

            throw new Error(`Unexpected request to ${config.url}`);
        });

        // First authenticate call to set an initial token (simulate existing valid/stale token)
        await Schulkonsole.authenticate();
        expect(tokenRequestCount).toBe(1);
        expect(Schulkonsole.authHeader).toBe('Bearer mock-token-1');

        // Now readIdentities. It should hit the 401 on students, clear token, authenticate again, and retry
        const identities = await Schulkonsole.readIdentities();

        expect(tokenRequestCount).toBe(2); // Should have authenticated again
        expect(studentsRequestCount).toBe(2); // Should have tried students twice
        expect(Schulkonsole.authHeader).toBe('Bearer mock-token-2'); // Should have the new token
        expect(identities).toHaveLength(1);
        expect(identities[0].userId).toBe('user1');
    });

    it('should not retry and throw if authentication itself fails with 401', async () => {
        let tokenRequestCount = 0;

        Schulkonsole.axiosInstance.defaults.adapter = jest.fn(async (config) => {
            if (config.url === Schulkonsole.tokenURL) {
                tokenRequestCount++;
                const err = new Error('Request failed with status code 401');
                err.response = {
                    status: 401,
                    statusText: 'Unauthorized',
                    headers: {},
                    config,
                    data: { error: 'Invalid credentials' }
                };
                err.config = config;
                throw err;
            }
            throw new Error(`Unexpected request to ${config.url}`);
        });

        await expect(Schulkonsole.authenticate()).rejects.toThrow();
        expect(tokenRequestCount).toBe(1); // No infinite retry loop
    });

    it('should retry a failed request once and succeed on SchulkonsoleTeacher when 401 is returned', async () => {
        let tokenRequestCount = 0;
        let teachersRequestCount = 0;

        SchulkonsoleTeacher.axiosInstance.defaults.adapter = jest.fn(async (config) => {
            if (config.url === SchulkonsoleTeacher.tokenURL) {
                tokenRequestCount++;
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: {
                        token_type: 'Bearer',
                        access_token: `mock-teacher-token-${tokenRequestCount}`
                    }
                };
            }

            if (config.url === `${SchulkonsoleTeacher.apiURL}teachers`) {
                teachersRequestCount++;
                if (teachersRequestCount === 1) {
                    // Fail the first time with 401
                    const err = new Error('Request failed with status code 401');
                    err.response = {
                        status: 401,
                        statusText: 'Unauthorized',
                        headers: {},
                        config,
                        data: { error: 'Invalid token' }
                    };
                    err.config = config;
                    throw err;
                } else {
                    // Succeed the second time
                    return {
                        status: 200,
                        statusText: 'OK',
                        headers: {},
                        config,
                        data: [
                            { id: 1, userName: 'teacher1', givenName: 'Jane', surname: 'Smith', initials: 'JS', email: 'js@test.com' }
                        ]
                    };
                }
            }

            throw new Error(`Unexpected request to ${config.url}`);
        });

        // First authenticate call to set an initial token
        await SchulkonsoleTeacher.authenticate();
        expect(tokenRequestCount).toBe(1);
        expect(SchulkonsoleTeacher.authHeader).toBe('Bearer mock-teacher-token-1');

        // Now readIdentities. It should hit the 401 on teachers, clear token, authenticate again, and retry
        const identities = await SchulkonsoleTeacher.readIdentities();

        expect(tokenRequestCount).toBe(2); // Should have authenticated again
        expect(teachersRequestCount).toBe(2); // Should have tried teachers twice
        expect(SchulkonsoleTeacher.authHeader).toBe('Bearer mock-teacher-token-2'); // Should have the new token
        expect(identities).toHaveLength(1);
        expect(identities[0].userId).toBe('JS');
    });

    it('should create missing class in lowercase on-the-fly when adding an identity', async () => {
        let createdClassPayload = null;
        let createdStudentPayload = null;

        Schulkonsole.axiosInstance.defaults.adapter = jest.fn(async (config) => {
            if (config.url === Schulkonsole.tokenURL) {
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: { token_type: 'Bearer', access_token: 'mock-token' }
                };
            }
            if (config.url === `${Schulkonsole.apiURL}school/schoolClasses`) {
                if (config.method.toLowerCase() === 'get') {
                    return {
                        status: 200,
                        statusText: 'OK',
                        headers: {},
                        config,
                        data: [] // No classes initially
                    };
                }
                if (config.method.toLowerCase() === 'post') {
                    createdClassPayload = JSON.parse(config.data);
                    return {
                        status: 200,
                        statusText: 'OK',
                        headers: {},
                        config,
                        data: { id: 42, name: createdClassPayload.name }
                    };
                }
            }
            if (config.url === `${Schulkonsole.apiURL}students`) {
                createdStudentPayload = JSON.parse(config.data);
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: { id: 999 }
                };
            }
            throw new Error(`Unexpected request to ${config.url}`);
        });

        await Schulkonsole.addIdentity({
            userId: 'max123',
            firstName: 'Max',
            lastName: 'Mustermann',
            clazz: '10A'
        });

        expect(createdClassPayload).not.toBeNull();
        expect(createdClassPayload.name).toBe('10a'); // must be lowercase
        expect(createdStudentPayload).not.toBeNull();
        expect(createdStudentPayload.schoolClass).toBe('42');
        expect(Schulkonsole.classes['10a']).toBe(42);
        expect(Schulkonsole.studentIds['max123']).toBe(999);
    });

    it('should create missing class in lowercase on-the-fly when changing an identity', async () => {
        let createdClassPayload = null;
        let updatedStudentPayload = null;

        Schulkonsole.studentIds['max123'] = 999;
        Schulkonsole.authHeader = 'Bearer mock-token';
        Schulkonsole.authTime = Date.now();

        Schulkonsole.axiosInstance.defaults.adapter = jest.fn(async (config) => {
            if (config.url === `${Schulkonsole.apiURL}school/schoolClasses` && config.method.toLowerCase() === 'post') {
                createdClassPayload = JSON.parse(config.data);
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: { id: 84, name: createdClassPayload.name }
                };
            }
            if (config.url === `${Schulkonsole.apiURL}students/999` && config.method.toLowerCase() === 'put') {
                updatedStudentPayload = JSON.parse(config.data);
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config,
                    data: { id: 999 }
                };
            }
            throw new Error(`Unexpected request to ${config.url}`);
        });

        await Schulkonsole.changeIdentity({
            userId: 'max123',
            firstName: 'Max',
            lastName: 'Mustermann',
            clazz: '05B'
        });

        expect(createdClassPayload).not.toBeNull();
        expect(createdClassPayload.name).toBe('05b'); // must be lowercase
        expect(updatedStudentPayload).not.toBeNull();
        expect(updatedStudentPayload.schoolClass).toBe('84');
        expect(Schulkonsole.classes['05b']).toBe(84);
    });
});
