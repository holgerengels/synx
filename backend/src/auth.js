const jwt = require('jsonwebtoken');
const ldap = require('ldapjs');
const fs = require('fs');

const escapeLDAP = (str) => {
    if (!str) return '';
    return str.replace(/[\*\(\)\\\0]/g, function (char) {
        switch (char) {
            case '*': return '\\2a';
            case '(': return '\\28';
            case ')': return '\\29';
            case '\\': return '\\5c';
            case '\0': return '\\00';
            default: return char;
        }
    });
};

// Load Config
const config = require('./config');
const settings = config.settings || {};

console.log(`[Auth] Settings loaded. DevMode: ${settings.devMode}`);

const MOCK_USERS = [
    { username: 'holger_engels', password: 'password', groups: ['Netzwerkteam'], displayName: 'Holger Engels' },
    { username: 'admin', password: 'password', groups: ['Netzwerkteam'], displayName: 'Admin' },
];

const devMode = settings.devMode !== false;
const SECRET_KEY = process.env.JWT_SECRET || (settings.server && settings.server.jwtSecret) || (devMode ? 'supersecretkey_synx' : null);
const REFRESH_SECRET_KEY = process.env.REFRESH_JWT_SECRET || (settings.server && settings.server.refreshJwtSecret) || (devMode ? 'supersecretrefreshkey_synx' : null);

if (!devMode && (!SECRET_KEY || !REFRESH_SECRET_KEY)) {
    throw new Error('CRITICAL: JWT Secrets must be configured in production (devMode: false). Set process.env.JWT_SECRET or settings.server.jwtSecret.');
}

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = (settings.server && settings.server.refreshTokenExpiry) || '30d';

const login = async (username, password, isPwa = true) => {
    username = username.toLowerCase();

    // 1. DevMode Check
    if (settings.devMode !== false) {
        const user = MOCK_USERS.find(u => u.username === username && u.password === password);
        if (user) {
            console.log(`[Auth] Mock login successful for ${username}`);
            const token = jwt.sign({ username: user.username, groups: user.groups }, SECRET_KEY, { expiresIn: ACCESS_TOKEN_EXPIRY });
            const result = { token, user: { username: user.username, groups: user.groups, displayName: user.displayName } };
            if (isPwa) result.refreshToken = generateRefreshToken(user.username, user.groups);
            return result;
        }
        
        const ldapConfig = settings.ldap || (settings.server && settings.server.ldap);
        if (!ldapConfig) {
            return null;
        }
    }

    // 2. LDAP Auth
    const ldapConfig = settings.ldap || (settings.server && settings.server.ldap);
    if (!ldapConfig) {
        console.error('[Auth] LDAP settings missing (settings.ldap)');
        return null;
    }

    return new Promise((resolve, reject) => {
        const client = ldap.createClient({ url: ldapConfig.url });

        client.on('error', (err) => {
            console.error('[Auth] LDAP Client Error:', err);
            reject(new Error('LDAP Connection Error: ' + err.message));
        });

        client.bind(ldapConfig.binddn, ldapConfig.bindpw, (err) => {
            if (err) {
                console.error('[Auth] LDAP Bind Error:', err);
                client.unbind();
                return reject(new Error('LDAP Bind Error (System Account): ' + err.message));
            }

            const escapedUsername = escapeLDAP(username);
            const baseFilter = ldapConfig.userfilter || '(objectClass=person)';
            const filter = `(&${baseFilter}(sAMAccountName=${escapedUsername}))`;
            const opts = { filter, scope: 'sub', attributes: ['dn', 'memberOf', 'givenName', 'sn'] };

            console.log(`[Auth] Executing LDAP search in base: ${ldapConfig.basedn}`);
            console.log(`[Auth] Filter: ${filter}`);

            client.search(ldapConfig.basedn, opts, (err, searchRes) => {
                if (err) {
                    client.unbind();
                    return reject(new Error('LDAP Search Error: ' + err.message));
                }

                let userEntry = null;

                searchRes.on('searchEntry', (entry) => {
                    if (entry.object) {
                        userEntry = entry.object;
                    } else {
                        // Fallback: Parse attributes manually if entry.object is missing
                        userEntry = { dn: entry.objectName ? entry.objectName.toString() : '' };
                        if (entry.attributes) {
                            entry.attributes.forEach(attr => {
                                userEntry[attr.type] = attr.values;
                            });
                        }
                    }
                });

                searchRes.on('end', (result) => {
                    if (result.status !== 0 || !userEntry) {
                        console.log(`[Auth] LDAP Search returned no user for ${username}. Status: ${result.status}`);
                        client.unbind(); return resolve(null);
                    }

                    const userClient = ldap.createClient({ url: ldapConfig.url });
                    userClient.bind(userEntry.dn, password, (err) => {
                        if (err) {
                            console.log(`[Auth] Failed to bind with user's DN (${userEntry.dn}): ${err.message}`);
                            userClient.unbind(); client.unbind(); return resolve(null);
                        }

                        userClient.unbind(); client.unbind();

                        const groups = [];
                        const rawGroups = Array.isArray(userEntry.memberOf) ? userEntry.memberOf : [userEntry.memberOf];
                        const prefix = ldapConfig.groupprefix || '';

                        if (rawGroups) {
                            rawGroups.forEach(groupDn => {
                                if (!groupDn) return;
                                const match = groupDn.match(/^CN=([^,]+)/i);
                                if (match) {
                                    const cn = match[1];
                                    if (cn.startsWith(prefix)) groups.push(cn.substring(prefix.length));
                                }
                            });
                        }

                        let givenName = userEntry.givenName || '';
                        let sn = userEntry.sn || '';
                        if (Array.isArray(givenName)) givenName = givenName[0];
                        if (Array.isArray(sn)) sn = sn[0];
                        const displayName = [givenName, sn].filter(Boolean).join(' ') || username;

                        console.log(`[Auth] User ${username} found. Raw AD Groups count: ${rawGroups ? rawGroups.length : 0}`);
                        console.log(`[Auth] Parsed internal groups:`, groups);

                        if (ldapConfig.allowedGroups && Array.isArray(ldapConfig.allowedGroups) && ldapConfig.allowedGroups.length > 0) {
                            const hasAccess = groups.some(g => ldapConfig.allowedGroups.includes(g));
                            if (!hasAccess) {
                                console.log(`[Auth] REJECTED: User ${username} does not belong to any allowed group.`);
                                console.log(`[Auth]   - User has: ${groups.join(', ') || 'none'}`);
                                console.log(`[Auth]   - Required: ${ldapConfig.allowedGroups.join(', ')}`);
                                return resolve(null);
                            }
                        }

                        const token = jwt.sign({ username: username, groups: groups }, SECRET_KEY, { expiresIn: ACCESS_TOKEN_EXPIRY });
                        const resObj = { token, user: { username, groups, displayName } };
                        if (isPwa) resObj.refreshToken = generateRefreshToken(username, groups);
                        resolve(resObj);
                    });
                });

                searchRes.on('error', (err) => {
                    client.unbind();
                    reject(new Error('LDAP Search Stream Error: ' + err.message));
                });
            });
        });
    });
};

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    jwt.verify(token.split(' ')[1], SECRET_KEY, (err, decoded) => {
        if (err) return res.status(401).json({ message: 'Failed to authenticate token' });
        req.user = decoded;
        next();
    });
};

const generateRefreshToken = (username, groups) => {
    return jwt.sign({ username, groups, type: 'refresh' }, REFRESH_SECRET_KEY, { expiresIn: REFRESH_TOKEN_EXPIRY });
};

const refreshAccessToken = (refreshToken) => {
    try {
        const decoded = jwt.verify(refreshToken, REFRESH_SECRET_KEY);
        if (decoded.type !== 'refresh') return null;

        const newAccessToken = jwt.sign(
            { username: decoded.username, groups: decoded.groups },
            SECRET_KEY,
            { expiresIn: ACCESS_TOKEN_EXPIRY }
        );
        return { token: newAccessToken, user: { username: decoded.username, groups: decoded.groups } };
    } catch (err) {
        return null;
    }
};

module.exports = { login, verifyToken, refreshAccessToken };
