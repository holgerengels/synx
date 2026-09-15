const axios = require('axios');
const https = require('https');
const Identity = require('../../domains/Identity');
const config = require('../../config');
const ManagableDomain = require('../../domains/ManagableDomain');

class Schulkonsole extends ManagableDomain {
    get supportedProperties() { return ['userId', 'firstName', 'lastName', 'clazz']; }
    get cacheTTL() { return 3600000; } // 1 hour

    constructor() {
        super('schulkonsole');
        const c = config.schulkonsole || {};
        this.apiURL = c.apiURL || process.env.SCHULKONSOLE_API;
        if (!this.apiURL) throw new Error('Schulkonsole apiURL missing');
        if (!this.apiURL.endsWith('/')) this.apiURL += '/';

        this.tokenURL = c.tokenURL || process.env.SCHULKONSOLE_TOKEN_URL;
        if (!this.tokenURL) throw new Error('Schulkonsole tokenURL missing');

        this.user = c.user || process.env.SCHULKONSOLE_USER;
        this.password = c.password || process.env.SCHULKONSOLE_PASSWORD;

        if (!this.user || !this.password) {
            throw new Error('Schulkonsole configuration incomplete. Missing user or password.');
        }

        this.axiosInstance = axios.create({
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        this.axiosInstance.interceptors.response.use(
            response => response,
            async error => {
                const originalRequest = error.config;
                const hasAuthHeader = originalRequest && originalRequest.headers &&
                    (originalRequest.headers['Authorization'] || originalRequest.headers['authorization']);
                if (
                    error.response &&
                    error.response.status === 401 &&
                    originalRequest &&
                    !originalRequest._retry &&
                    hasAuthHeader &&
                    !this.isAuthenticating
                ) {
                    originalRequest._retry = true;
                    this.authHeader = null;
                    this.authTime = 0;
                    try {
                        await this.authenticate();
                        if (originalRequest.headers['Authorization']) {
                            originalRequest.headers['Authorization'] = this.authHeader;
                        }
                        if (originalRequest.headers['authorization']) {
                            originalRequest.headers['authorization'] = this.authHeader;
                        }
                        if (!originalRequest.headers['Authorization'] && !originalRequest.headers['authorization']) {
                            originalRequest.headers['Authorization'] = this.authHeader;
                        }
                        return this.axiosInstance(originalRequest);
                    } catch (authError) {
                        return Promise.reject(authError);
                    }
                }
                return Promise.reject(error);
            }
        );

        this.classes = {}; // maps lowercase name to ID
        this.studentIds = {}; // maps lowercase account to ID
        this.isAuthenticating = false;
    }

    async authenticate() {
        if (this.authHeader && Date.now() - this.authTime < 3600000) return;
        this.isAuthenticating = true;
        try {
            const tokenRes = await this.axiosInstance.post(this.tokenURL, {
                grant_type: 'password', username: this.user, password: this.password
            }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            this.authHeader = `${tokenRes.data.token_type} ${tokenRes.data.access_token}`;
            this.authTime = Date.now();

            // Ensure classes are loaded alongside auth
            await this.loadClasses();
        } finally {
            this.isAuthenticating = false;
        }
    }

    async loadClasses() {
        const classRes = await this.axiosInstance.get(`${this.apiURL}school/schoolClasses`, {
            headers: { 'Authorization': this.authHeader }
        });
        this.classes = {};
        classRes.data.forEach(c => this.classes[c.name.toLowerCase()] = c.id);
    }

    async readIdentities() {
        try {
            await this.authenticate();
            const stdRes = await this.axiosInstance.get(`${this.apiURL}students`, {
                headers: { 'Authorization': this.authHeader }
            });

            this.studentIds = {};
            return stdRes.data.map(r => {
                this.studentIds[r.userName.toLowerCase()] = r.id;
                // Reverse lookup the class ID back to its string name for Identity construction
                const className = Object.keys(this.classes).find(key => this.classes[key] === parseInt(r.schoolClass) || this.classes[key] === r.schoolClass) || r.schoolClass;
                return new Identity(
                    r.userName,
                    r.givenName,
                    r.surname,
                    {
                        id: r.id,
                        clazz: (className || '').toUpperCase()
                    }
                );
            });
        } catch (e) {
            // console.error('Schulkonsole read error:', e.message);
            throw new Error('Schulkonsole read error: ' + e.message);
        }
    }

    async addClass(className) {
        if (!className) return null;
        const normalizedClassName = className.toLowerCase().trim();
        if (!normalizedClassName) return null;

        await this.authenticate();
        let classId = this.classes[normalizedClassName];
        if (classId) return classId; // already exists

        const payload = {
            name: normalizedClassName,
            schoolTypeId: 1,
            schoolYear: config.schulkonsole?.schuljahr
        };
        const res = await this.axiosInstance.post(`${this.apiURL}school/schoolClasses`, payload, {
            headers: { 'Authorization': this.authHeader }
        });

        classId = res.data.id;
        this.classes[normalizedClassName] = classId;
        return classId;
    }

    async removeClass(className) {
        if (!className) return;
        const normalizedClassName = className.toLowerCase().trim();
        await this.authenticate();
        let classId = this.classes[normalizedClassName];
        if (!classId) return; // does not exist

        await this.axiosInstance.delete(`${this.apiURL}school/schoolClasses`, {
            headers: { 'Authorization': this.authHeader },
            data: [classId]
        });

        delete this.classes[normalizedClassName];
    }

    async addIdentity(identity) {
        await this.authenticate();
        const normalizedClassName = (identity.clazz || '').toLowerCase().trim();
        let classId = normalizedClassName ? this.classes[normalizedClassName] : null;
        if (normalizedClassName && !classId) {
            classId = await this.addClass(normalizedClassName);
        }
        if (!classId) throw new Error(`Class '${identity.clazz}' not found or could not be created in Schulkonsole.`);

        const payload = {
            schoolType: "1", comments: "", externalIdentifier: "", mySite: "",
            userName: identity.userId, givenName: identity.firstName, surname: identity.lastName,
            schoolClass: classId.toString(),
            isInternetLocked: false, isDeactivated: false, homeDirectory: "",
            password: config.schulkonsole?.initialPassword || "Start123!",
            passwordPolicy: config.schulkonsole?.passwordPolicy || "2",
            email: `${identity.userId}@musterschule.schule.paedml`
        };

        const res = await this.axiosInstance.post(`${this.apiURL}students`, payload, {
            headers: { 'Authorization': this.authHeader }
        });
        if (res.data && res.data.id) {
            this.studentIds[identity.userId.toLowerCase()] = res.data.id;
        }
        return res.data;
    }

    async changeIdentity(identity) {
        await this.authenticate();
        const existingId = this.studentIds[identity.userId.toLowerCase()];
        if (!existingId) throw new Error(`Student ${identity.userId} not found. Must run getIdentities() first.`);

        const normalizedClassName = (identity.clazz || '').toLowerCase().trim();
        let classId = normalizedClassName ? this.classes[normalizedClassName] : null;
        if (normalizedClassName && !classId) {
            classId = await this.addClass(normalizedClassName);
        }

        const payload = {
            schoolType: "1", comments: "", externalIdentifier: "", mySite: "",
            userName: identity.userId, givenName: identity.firstName, surname: identity.lastName,
            schoolClass: classId ? classId.toString() : "",
            isInternetLocked: false, isDeactivated: false,
            homeDirectory: `\\\\SP01\\MLData\\Benutzer\\SUS\\${identity.userId}`
        };

        await this.axiosInstance.put(`${this.apiURL}students/${existingId}`, payload, {
            headers: { 'Authorization': this.authHeader }
        });
    }

    async removeIdentity(identity) {
        await this.authenticate();
        const existingId = this.studentIds[identity.userId.toLowerCase()];
        if (!existingId) return; // Ignore if already not existing

        await this.axiosInstance.delete(`${this.apiURL}students`, {
            headers: { 'Authorization': this.authHeader },
            data: [existingId]
        });

        delete this.studentIds[identity.userId.toLowerCase()];
    }
}

module.exports = new Schulkonsole();
