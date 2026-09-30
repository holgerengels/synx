const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const otpauth = require('otpauth');
const Identity = require('../../domains/Identity');
const config = require('../../config');
const ManagableDomain = require('../../domains/ManagableDomain');
const { parseCsvLine } = require('../../utils/csvParser');

function formatAxiosError(err, context = 'WebUntis request failed') {
    if (!err) return context;

    const method = (err.config?.method || 'GET').toUpperCase();
    const url = err.config?.url || '';
    const status = err.response?.status;
    const statusText = err.response?.statusText || '';

    let callInfo = url ? `[${method} ${url}]` : '';
    let details = `${context} ${callInfo}`.trim();

    if (status) {
        details += ` -> HTTP ${status} ${statusText}`.trim();
    } else if (err.code) {
        details += ` -> ${err.code}: ${err.message}`;
    } else {
        details += ` -> ${err.message}`;
    }

    if (err.config?.params) {
        try {
            details += ` | Params: ${JSON.stringify(err.config.params)}`;
        } catch (_) {}
    }

    if (err.response?.data) {
        let respData = err.response.data;
        if (typeof respData === 'object') {
            try {
                respData = JSON.stringify(respData);
            } catch (_) {
                respData = String(respData);
            }
        } else if (typeof respData === 'string') {
            const trimmed = respData.trim();
            if (trimmed.startsWith('<')) {
                const titleMatch = trimmed.match(/<title[^>]*>([^<]*)<\/title>/i);
                const title = titleMatch ? `[Title: ${titleMatch[1].trim()}] ` : '';
                const bodyText = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                respData = (title + bodyText).substring(0, 300);
            } else {
                respData = trimmed.substring(0, 300);
            }
        }
        if (respData) {
            details += ` | Response: ${respData}`;
        }
    }

    return details;
}

class WebUntisDomain extends ManagableDomain {
    get supportedProperties() { return ['userId', 'firstName', 'lastName', 'clazz', 'birthday']; }
    get cacheTTL() { return 3600000; } // 1 hour

    constructor() {
        super('webuntis');
        const c = config.webuntis || {};
        this.url = c.url;
        if (!this.url) throw new Error('WebUntis url missing');
        if (!this.url.endsWith('/')) this.url += '/';

        this.school = c.school || '';
        this.loginPath = c.login || 'j_spring_security_check';
        if (this.loginPath.startsWith('/')) this.loginPath = this.loginPath.substring(1);

        this.reportPath = c.report || 'reports.do';
        if (this.reportPath.startsWith('/')) this.reportPath = this.reportPath.substring(1);

        this.fetchStudents = c.fetchStudents || 'name=Student&format=csv&klasseId=-1&studentsForDate=true&context=klasseId';

        this.user = c.user || process.env.WEBUNTIS_USER;
        this.password = c.password || process.env.WEBUNTIS_PASSWORD;
        this.secret = c.secret || process.env.WEBUNTIS_SECRET;

        if (!this.user || !this.password) {
            throw new Error('WebUntis configuration incomplete. Missing user or password.');
        }
    }

    /**
     * Fetch report CSV, either directly if reportParams is already provided,
     * or by polling WebUntis's polling endpoint (/api/polling/REPORT) until the report job finishes.
     * 
     * @param {object} client - authenticated axios client
     * @param {string|number} messageId - report message ID from the generation request
     * @param {string} reportParams - query parameters for the report (if already available)
     * @param {string} label - human-readable label for logging
     * @param {object} reportMeta - { reportName, format }
     * @returns {string} CSV content
     */
    async _pollReport(client, messageId, reportParams, label = 'report', reportMeta = {}) {
        // 1. If reportParams is already available (synchronous report like Student), download directly
        if (reportParams) {
            const fetchUrl = this.url + this.reportPath + `?msgId=${messageId}&${reportParams}`;
            console.log(`[WebUntis] ${label} ready immediately. Fetching content: GET ${fetchUrl}`);
            const fetchRes = await client.get(fetchUrl);
            if (typeof fetchRes.data === 'string' && fetchRes.data.trim().length > 0) {
                return fetchRes.data;
            }
        }

        // 2. Otherwise poll WebUntis polling API: /api/polling/REPORT
        const maxAttempts = 15;
        const delays = [2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
        const pollingUrl = this.url + 'api/polling/REPORT';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const delay = delays[attempt - 1] || 5000;
            await new Promise(r => setTimeout(r, delay));

            console.log(`[WebUntis] Polling ${label} via ${pollingUrl} (attempt ${attempt}/${maxAttempts})...`);
            try {
                const pollRes = await client.get(pollingUrl);
                const pollingData = pollRes.data?.data;
                const jobs = pollingData?.pollingJobs || [];

                // Find matching job (by reportName if available, or first finished job)
                const job = (reportMeta.reportName
                    ? jobs.find(j => j.data?.reportName === reportMeta.reportName)
                    : null) || jobs[0];

                if (job) {
                    console.log(`[WebUntis] ${label} job status: isJobFinished=${job.isJobFinished}, hasJobError=${job.hasJobError}`);
                    if (job.hasJobError) {
                        throw new Error(`WebUntis reported error during generation of ${label}: ${JSON.stringify(job)}`);
                    }

                    if (job.isJobFinished && job.data?.reportParams) {
                        const downloadMsgId = job.data.messageId !== undefined ? job.data.messageId : messageId;
                        const fetchUrl = this.url + this.reportPath + `?msgId=${downloadMsgId}&${job.data.reportParams}`;
                        console.log(`[WebUntis] ${label} finished on server! Fetching content: GET ${fetchUrl}`);
                        const fetchRes = await client.get(fetchUrl);
                        if (typeof fetchRes.data === 'string' && fetchRes.data.trim().length > 0) {
                            return fetchRes.data;
                        }
                    }
                } else {
                    console.log(`[WebUntis] No polling job returned yet (hasRunningJobs=${pollingData?.hasRunningJobs}). Waiting...`);
                }

                console.log(`[WebUntis] ${label} not ready yet. Waiting ${delay / 1000}s...`);
            } catch (err) {
                const pollErr = formatAxiosError(err, `[WebUntis] Polling ${label} failed on attempt ${attempt}`);
                console.error(pollErr);
                if (err.response?.data) {
                    console.error('[WebUntis] Poll error response data:', err.response.data);
                }
                throw new Error(pollErr);
            }
        }

        throw new Error(`WebUntis ${label} did not become ready after ${maxAttempts} attempts.`);
    }

    async readIdentities() {
        let client = this.authClient;

        // Reuse existing session if available, otherwise create a new one
        if (!client) {
            client = await this._login();
        }

        try {
            return await this._fetchStudentReport(client);
        } catch (e) {
            // If the existing session is stale, retry with a fresh login (only on 401/403)
            const isAuthErr = e.response?.status === 401 || e.response?.status === 403 || e.message?.includes('401') || e.message?.includes('403');
            if (this.authClient && isAuthErr) {
                console.log('[WebUntis] Session expired (got 401/403). Re-authenticating...');
                client = await this._login();
                return await this._fetchStudentReport(client);
            }
            const formatted = formatAxiosError(e, 'WebUntis readIdentities error');
            console.error(formatted);
            throw new Error(formatted);
        }
    }

    async _login() {
        console.log(`[WebUntis] Authenticating user '${this.user}' at ${this.url}...`);
        const jar = new CookieJar();
        const client = wrapper(axios.create({ jar, timeout: 10000 }));

        client.interceptors.request.use(req => {
            console.log(`[WebUntis HTTP Request] ${req.method?.toUpperCase()} ${req.url}`);
            return req;
        });

        client.interceptors.response.use(
            res => res,
            err => {
                const method = (err.config?.method || 'UNKNOWN').toUpperCase();
                const url = err.config?.url || 'UNKNOWN_URL';
                const status = err.response?.status;
                const statusText = err.response?.statusText || '';
                console.error(`[WebUntis HTTP Error] ${method} ${url} -> HTTP ${status || 'ERR'} ${statusText} (${err.message})`);
                if (err.response?.data) {
                    const dataPreview = typeof err.response.data === 'object'
                        ? JSON.stringify(err.response.data)
                        : String(err.response.data).substring(0, 500);
                    console.error(`[WebUntis HTTP Error Body] ${dataPreview}`);
                }
                return Promise.reject(err);
            }
        );

        let token = '';
        if (this.secret) {
            const totp = new otpauth.TOTP({
                issuer: 'WebUntis',
                label: this.user,
                algorithm: 'SHA1',
                digits: 6,
                period: 30,
                secret: this.secret
            });
            token = totp.generate();
        }

        // WebUntis requires initial GET for JSESSIONID before POSTing spring security check.
        // The school parameter must be present on this initial request to bind the session.
        const initUrl = this.school ? `${this.url}?school=${this.school}` : this.url;
        console.log(`[WebUntis] Initial session request: GET ${initUrl}`);
        await client.get(initUrl, { validateStatus: false });

        const params = new URLSearchParams();
        params.append('j_username', this.user);
        params.append('j_password', this.password);
        if (token) params.append('token', token);

        const loginUrl = this.url + this.loginPath;
        console.log(`[WebUntis] Security check request: POST ${loginUrl}`);
        const loginRes = await client.post(loginUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 0,
            validateStatus: false
        });
        console.log(`[WebUntis] Login completed with status ${loginRes.status}`);

        // Keep the authenticated client for potential updates
        this.authClient = client;
        return client;
    }

    /**
     * Request a report from WebUntis, with automatic backoff retry if WebUntis reports
     * that a previous report is still running/generating.
     */
    async _requestReport(client, url, label = 'report', maxAttempts = 5) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[WebUntis] Requesting ${label} (attempt ${attempt}/${maxAttempts}): GET ${url}`);
                const genRes = await client.get(url);
                console.log(`[WebUntis] ${label} response status: ${genRes.status}, data:`, typeof genRes.data === 'object' ? JSON.stringify(genRes.data) : String(genRes.data).substring(0, 500));
                if (!genRes.data) {
                    console.error(`[WebUntis] genRes.data is undefined for ${label}!`);
                    throw new Error(`WebUntis did not return valid report data from GET ${url}.`);
                }
                return genRes;
            } catch (err) {
                const respStr = JSON.stringify(err.response?.data || '');
                const isWaitingForPreviousReport = respStr.includes('Bitte warten Sie auf den vorigen Bericht') ||
                    (err.response?.data?.errors?.some(e => e.code === '4' || (e.title && e.title.includes('vorigen Bericht'))));

                if (isWaitingForPreviousReport && attempt < maxAttempts) {
                    const waitTime = attempt * 5000; // 5s, 10s, 15s, 20s
                    console.warn(`[WebUntis] ${label} blocked because a previous report is still generating in WebUntis. Waiting ${waitTime / 1000}s before retry (attempt ${attempt}/${maxAttempts})...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                throw err;
            }
        }
    }

    async _fetchStudentReport(client) {
        const reportUrl = this.url + this.reportPath + '?' + this.fetchStudents;
        let genRes;
        try {
            genRes = await this._requestReport(client, reportUrl, 'Student report');
        } catch (e) {
            const formatted = formatAxiosError(e, 'WebUntis student report request failed');
            console.error(formatted);
            throw new Error(formatted);
        }

        const data = genRes.data?.data;
        const messageId = data?.messageId;
        const reportParams = data?.reportParams || '';
        const reportMeta = {
            reportName: data?.reportName,
            format: data?.format || 'csv'
        };

        if (data?.error) {
            console.error('[WebUntis] Student report returned error:', genRes.data);
            throw new Error(`WebUntis report error for Student report. Server response: ${JSON.stringify(genRes.data)}`);
        }

        if (messageId === undefined || messageId === null) {
            console.error('[WebUntis] Student report returned no messageId:', genRes.data);
            throw new Error(`WebUntis did not return messageId for Student report. Server response: ${JSON.stringify(genRes.data)}`);
        }

        console.log(`[WebUntis] Student report triggered (messageId: ${messageId}, finished: ${data?.finished}). Polling...`);
        const csv = await this._pollReport(client, messageId, reportParams, 'Student CSV', reportMeta);

        const lines = csv.split('\n');
        const identities = [];
        this.internalIds = {};

        // Parse headers
        let majorityColIdx = -1;
        if (lines.length > 0) {
            const headers = parseCsvLine(lines[0].trim());
            majorityColIdx = headers.indexOf('majority');
            if (majorityColIdx === -1) {
                console.warn('[WebUntis Info] "majority" column missing in WebUntis CSV export headers. Automatic majority resolving disabled.');
            }
        }

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = parseCsvLine(line);
            if (cols.length >= 6) {
                const externKey = cols[0];
                const lastName = cols[1];
                const firstName = cols[2];
                const genderStr = cols[3];
                const birthdayStr = cols[4];
                const clazz = cols[5];
                const internalId = cols.length > 9 ? cols[9] : undefined;
                const accountId = externKey || internalId || `idx-${i}`;

                let majorityFlag = false;
                if (majorityColIdx !== -1 && cols.length > majorityColIdx) {
                    const val = cols[majorityColIdx] ? cols[majorityColIdx].toLowerCase() : '';
                    majorityFlag = (val === 'true');
                }

                if (lastName === 'Tester_Schüler' || accountId === 'Tester_Schüler') {
                    // console.log(`[CSV DUMP] Tester_Schüler columns:`, cols);
                    this.testerCsv = cols; // Expose for our HTTP API inspection route!
                }

                if (internalId && accountId) {
                    this.internalIds[accountId] = internalId;
                }

                let birthday = null;
                if (birthdayStr && birthdayStr.includes('.')) {
                    const parts = birthdayStr.split('.');
                    if (parts.length === 3) {
                        const day = parts[0];
                        const month = parts[1];
                        const year = parts[2];
                        birthday = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                    }
                }

                let normGender = null;
                if (genderStr) {
                    const str = genderStr.toUpperCase();
                    if (str.startsWith('M') || str === '1ÄNNLICH') normGender = 'M';
                    else if (str.startsWith('W') || str.startsWith('F')) normGender = 'W';
                    else normGender = 'D';
                }

                identities.push(new Identity(
                    accountId,
                    firstName,
                    lastName,
                    {
                        domain: 'webuntis',
                        id: accountId,
                        gender: normGender,
                        clazz,
                        birthday,
                        majority: majorityFlag
                    }
                ));
            }
        }

        return identities.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    }

    async changeIdentity(identity) {
        if (!this.internalIds) await this.getIdentities();

        const internalId = this.internalIds[identity.userId];
        if (!internalId) throw new Error(`Cannot change WebUntis identity: No internalId found for account ${identity.userId}`);

        if (!this.authClient) throw new Error(`WebUntis authClient not initialized. Core login failed.`);

        try {
            // Fetch CSRF token via index.do
            const indexRes = await this.authClient.get(this.url + 'index.do', { validateStatus: false });
            const htmlStr = typeof indexRes.data === 'string' ? indexRes.data : JSON.stringify(indexRes.data);
            const csrfMatch = htmlStr.match(/"csrfToken"\s*:\s*"([^"]+)"/) || htmlStr.match(/csrfToken":"([^"]+)"/);
            const csrfToken = csrfMatch ? csrfMatch[1] : '';

            // Scrape the form to preserve enrollments
            // Do not GET the studentform.do here. Fetching it via GET populates Spring's 
            // @SessionAttributes. If we then POST back without the exact `lastUpdate` 
            // from the internal JSON model, it throws an Optimistic Locking Failure 
            // ("Gleichzeitiger Benutzerzugriff"). By skipping the GET and POSTing directly, 
            // Spring binds our payload directly to a freshly fetched entity, preserving 
            // unsubmitted fields (like entryExitDateRanges) automatically.

            const savePayload = new URLSearchParams();
            if (csrfToken) savePayload.append('_csrf', csrfToken);
            savePayload.append('request.preventCache', String(Date.now()));
            savePayload.append('change', 'change');
            savePayload.append('selId', internalId);
            savePayload.append('id', internalId);

            // Only set fields that are explicitly provided to avoid overwriting with empty values.
            // Spring preserves unsubmitted fields automatically (see comment above).
            if (identity.userId) {
                savePayload.set('name', identity.userId);
                savePayload.set('externKey', identity.userId);
            }
            if (identity.lastName) savePayload.set('longName', identity.lastName);
            if (identity.firstName) savePayload.set('foreName', identity.firstName);

            // Format YYYY-MM-DD as explicitly required by Dojo for birthDate
            if (identity.birthday) {
                savePayload.set('birthDate', identity.birthday); // already in YYYY-MM-DD
            }

            // Identity uses strictly uppercase M, W, D
            let webuntisGender = '';
            if (identity.gender === 'M') webuntisGender = '2';
            else if (identity.gender === 'W') webuntisGender = '1';
            else if (identity.gender === 'D') webuntisGender = '3';

            if (webuntisGender) {
                savePayload.set('genderId', webuntisGender);
            }

            // Honor majority toggle if passed in
            if (identity.majority === true) {
                savePayload.set('majority', 'true');
                savePayload.set('_majority', 'on');
            } else if (identity.majority === false) {
                // To set a checkbox to false in Spring, omit the boolean value but send the hidden _ parameter
                savePayload.set('_majority', 'on');
            }

            // Set exit date via entryExitDateRanges if provided (YYYYMMDD as number)
            if (identity.exitDate) {
                const exitDateNum = parseInt(identity.exitDate.replace(/-/g, ''), 10);
                const entryExitDateRanges = JSON.stringify([
                    { startDate: 0, endDate: exitDateNum },
                    { startDate: 0, endDate: 0 }
                ]);
                savePayload.set('entryExitDateRanges', entryExitDateRanges);
            }

            savePayload.set('active', 'true');
            savePayload.set('_active', 'on');

            const payloadString = savePayload.toString();
            // console.log(`[Domain] Prepared sparse POST payload for student ${internalId}`);

            const saveRes = await this.authClient.post(this.url + `studentform.do`, payloadString, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': csrfToken
                },
                validateStatus: false
            });
            this.lastSaveStatus = saveRes.status;
            this.lastSaveHtml = typeof saveRes.data === 'string' ? saveRes.data.substring(0, 1500) : "JSON";
            // console.log(`[WebUntis] studentform.do save result: HTTP ${saveRes.status} Location: ${saveRes.headers['location']}`);
            
            if (saveRes.status === 200 && typeof saveRes.data === 'string') {
                if (saveRes.data.includes('this.setError(')) {
                     // Extract the error message for logging
                     const errorMatch = saveRes.data.match(/this\.setError\([^,]+,\s*'([^']+)'/);
                     const errorMsg = errorMatch ? errorMatch[1] : 'Unknown Validation Error';
                     throw new Error(`WebUntis validation error during save: ${errorMsg}`);
                } else {
                     console.log("[WebUntis] Body returned instead of redirect, but no explicit error found.");
                }
            }

            if (saveRes.status >= 400 && saveRes.status !== 403 && saveRes.status !== 302) {
                console.error(`WebUntis mutation failed. Status: ${saveRes.status}`);
            } else if (saveRes.status === 403) {
                throw new Error('WebUntis access denied (403). Write privileges might be missing or CSRF invalid.');
            }

            this.invalidate();

        } catch (e) {
            const formatted = formatAxiosError(e, `WebUntis changeIdentity error for ${identity.userId}`);
            console.error(formatted);
            throw new Error(formatted);
        }
    }
    async writeExitDates(map) {
        if (!map || Object.keys(map).length === 0) return [];

        const updatedUsers = [];

        for (const [userId, exitDateStr] of Object.entries(map)) {
            try {
                console.log(`[WebUntis] Setting exit date for ${userId}: ${exitDateStr}`);
                await this.changeIdentity({ userId, exitDate: exitDateStr });
                updatedUsers.push(userId);
                console.log(`[WebUntis] Exit date ${exitDateStr} set for ${userId}`);
                await new Promise(r => setTimeout(r, 200));
            } catch (err) {
                console.error(`[WebUntis] Error setting exit date for ${userId}:`, err.message);
            }
        }

        return updatedUsers;
    }

    async readGuardians() {
        let client = this.authClient;
        if (!client) {
            console.log('[WebUntis] Establishing session for readGuardians...');
            client = await this._login();
        }

        const fetchGuardiansConfig = config.webuntis?.fetchGuardians || 'name=LegalGuardian&format=csv&elementsForDate=false&klasseId=-1&schoolyearId=-1&searchString=&exitDateFilter=0&guardianFilterTypeId=-1&context=klasseId';
        const requestUrl = this.url + this.reportPath + '?' + fetchGuardiansConfig;

        const executeRead = async (activeClient) => {
            const genRes = await this._requestReport(activeClient, requestUrl, 'Guardian report');

            // If genRes.data is already CSV string (some reports return directly)
            if (typeof genRes.data === 'string' && genRes.data.trim().length > 0 && !genRes.data.trim().startsWith('{')) {
                console.log('[WebUntis] Guardian report returned CSV directly without polling.');
                return this._parseGuardiansCsv(genRes.data);
            }

            const data = genRes.data?.data;
            const messageId = data?.messageId;
            const reportParams = data?.reportParams || '';
            const reportMeta = {
                reportName: data?.reportName,
                format: data?.format || 'csv'
            };

            if (data?.error) {
                console.error('[WebUntis] Guardian report returned error:', genRes.data);
                throw new Error(`WebUntis report error for Guardian report. Server response: ${JSON.stringify(genRes.data)}`);
            }

            if (messageId === undefined || messageId === null) {
                console.error('[WebUntis] Guardian report returned no messageId:', genRes.data);
                throw new Error(`WebUntis did not return messageId for Guardian report. Server response: ${JSON.stringify(genRes.data)}`);
            }

            console.log(`[WebUntis] Guardian report queued (messageId: ${messageId}, finished: ${data?.finished}, reportParams: "${reportParams}"). Polling...`);
            const csv = await this._pollReport(activeClient, messageId, reportParams, 'Guardian CSV', reportMeta);
            return this._parseGuardiansCsv(csv);
        };

        try {
            return await executeRead(client);
        } catch (e) {
            // Check if session is truly expired (401 Unauthorized or 403 Forbidden)
            const isAuthErr = e.response?.status === 401 || e.response?.status === 403 || e.message?.includes('401') || e.message?.includes('403');
            if (this.authClient && isAuthErr) {
                console.warn(`[WebUntis] readGuardians encountered HTTP ${e.response?.status || 'auth failure'}. Re-authenticating and retrying...`);
                try {
                    client = await this._login();
                    return await executeRead(client);
                } catch (retryErr) {
                    const formatted = formatAxiosError(retryErr, 'WebUntis readGuardians error (after re-authentication)');
                    console.error(formatted);
                    if (retryErr.response?.data) {
                        console.error('[WebUntis] Full error response data:', retryErr.response.data);
                    }
                    throw new Error(formatted);
                }
            }

            const formatted = formatAxiosError(e, 'WebUntis readGuardians error');
            console.error(formatted);
            if (e.response?.data) {
                console.error('[WebUntis] Full error response data:', e.response.data);
            }
            throw new Error(formatted);
        }
    }

    _parseGuardiansCsv(csv) {
        const lines = (typeof csv === 'string') ? csv.split('\n') : [];
        const guardiansMap = {};
        const guardians = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = parseCsvLine(line);
            if (cols.length >= 14) {
                const id = cols[0]; // Guardian ID
                const lastName = cols[1];
                const firstName = cols[2];
                const email = cols[6] ? cols[6].toLowerCase() : '';
                const studentAccount = cols[15];
                const studentFirstName = cols[12];
                const studentLastName = cols[11];

                if (!id) continue;

                let guardian = guardiansMap[id];
                if (!guardian) {
                    guardian = {
                        id: id,
                        email: email,
                        firstName: firstName,
                        lastName: lastName,
                        students: []
                    };
                    guardiansMap[id] = guardian;
                    guardians.push(guardian);
                }

                if (studentAccount) {
                    // Only add if not duplicate
                    if (!guardian.students.find(s => s.account === studentAccount)) {
                        guardian.students.push({
                            account: studentAccount,
                            firstName: studentFirstName,
                            lastName: studentLastName
                        });
                    }
                }
            }
        }

        console.log(`[WebUntis] Successfully read ${guardians.length} guardians from WebUntis.`);
        return guardians;
    }

    async changeGuardian(guardian, studentAccounts) {
        let client = this.authClient;
        if (!client || !this.internalIds) {
            await this.readIdentities(); // Establishes auth Client and populates this.internalIds
            client = this.authClient;
        }

        const addGuardianPath = config.webuntis?.addGuardian || 'legalguardianform.do';
        const guardianUrl = this.url + addGuardianPath;

        try {
            // Determine internal student IDs
            console.log(`[WebUntis Guardian] Processing ${guardian.email}: studentAccounts=${JSON.stringify(studentAccounts)}, internalIds keys sample: ${Object.keys(this.internalIds).slice(0, 5).join(', ')}...`);
            const studentInternalIds = [];
            for (const acc of studentAccounts) {
                const intId = this.internalIds[acc];
                if (intId) {
                    studentInternalIds.push(intId);
                    console.log(`[WebUntis Guardian]   ${acc} → internalId ${intId}`);
                } else {
                    console.warn(`[WebUntis Sync] Warning: Student account ${acc} has no internalId mapped in WebUntis. Skipping attachment. Available keys containing '${acc.substring(0, 8)}': ${Object.keys(this.internalIds).filter(k => k.includes(acc.substring(0, 8))).join(', ') || 'NONE'}`);
                }
            }
            console.log(`[WebUntis Guardian] Final relatedStudentIds for ${guardian.email}: [${studentInternalIds.join(', ')}]`);

            // Fetch CSRF token
            console.log(`[WebUntis Guardian] Fetching CSRF form: GET ${guardianUrl}`);
            const indexRes = await client.get(guardianUrl, { validateStatus: false });
            const htmlStr = typeof indexRes.data === 'string' ? indexRes.data : JSON.stringify(indexRes.data);

            let csrfMatch = htmlStr.match(/"csrfToken"\s*:\s*"([^"]+)"/) || htmlStr.match(/csrfToken":"([^"]+)"/);
            let csrfToken = csrfMatch ? csrfMatch[1] : '';
            if (!csrfToken) {
                const fallbackCsrf = htmlStr.match(/<input[^>]+type="hidden"[^>]+name="_csrf"[^>]+value="([^"]+)"/i);
                if (fallbackCsrf) csrfToken = fallbackCsrf[1];
            }

            const payload = new URLSearchParams();
            payload.append('change', 'change');
            payload.append('id', guardian.id || '-1');
            payload.append('lastUpdate', '0');
            payload.append('degree', '');
            payload.append('lastName', guardian.lastName || '');
            payload.append('firstName', guardian.firstName || '');
            payload.append('shortName', '');
            payload.append('grade', '');
            payload.append('postgrade', '');
            payload.append('externKey', '');
            payload.append('nationalId', '');
            payload.append('email', guardian.email || '');
            payload.append('phone', '');
            payload.append('mobile', '');
            payload.append('street', '');
            payload.append('postalCode', '');
            payload.append('city', '');
            payload.append('userName', '');

            for (const stId of studentInternalIds) {
                payload.append('relatedStudentIds', stId);
            }

            if (csrfToken) payload.append('_csrf', csrfToken);

            console.log(`[WebUntis Guardian] Saving guardian ${guardian.email}: POST ${guardianUrl}`);
            const saveRes = await client.post(guardianUrl, payload.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': csrfToken || ''
                },
                validateStatus: false,
                maxRedirects: 0
            });

            if (saveRes.status >= 400 && saveRes.status !== 403 && saveRes.status !== 302) {
                console.error(`WebUntis Guardian mutation failed for ${guardian.email}. Status: ${saveRes.status}`);
            } else if (saveRes.status === 403) {
                throw new Error(`WebUntis Guardian access denied (403) for ${guardian.email}. Write privileges might be missing or CSRF invalid.`);
            }

            return { success: saveRes.status < 400 || saveRes.status === 302, status: saveRes.status };

        } catch (e) {
            const formatted = formatAxiosError(e, `WebUntis changeGuardian error for ${guardian.email}`);
            console.error(formatted);
            throw new Error(formatted);
        }
    }
}

module.exports = new WebUntisDomain();
