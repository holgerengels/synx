const ldap = require('ldapjs');
const Task = require('../../tasks/Task');
const config = require('../../config');
const devModeUtils = require('../../utils/devMode');

const UF_DONT_EXPIRE_PASSWD = 0x10000; // 65536

/**
 * PaedmlFixPasswordExpirationTask
 *
 * Finds student accounts in the PaedML / Active Directory LDAP whose passwords
 * or accounts have an expiration configured, and removes the expiration.
 *
 * Password expiration is controlled by the DONT_EXPIRE_PASSWORD flag (0x10000)
 * in userAccountControl. If not set, the password expires after domain maxPwdAge.
 * In addition, any non-zero accountExpires attribute is reset to 0.
 *
 * DevMode: Only limits writes in dev mode to prevent mass modifications.
 */
class PaedmlFixPasswordExpirationTask extends Task {
    constructor() {
        super('paedml-fix-password-expiration');
    }

    async execute() {
        const devMode = devModeUtils.isDevMode();
        const ldapConfig = config.ldap;

        if (!ldapConfig || !ldapConfig.url) {
            return {
                success: false,
                error: 'LDAP configuration missing (config.ldap).'
            };
        }

        // ── Step 1: Read student accounts from LDAP ───────────────────────
        let entries;
        try {
            entries = await this._readStudentEntries(ldapConfig);
        } catch (e) {
            return {
                success: false,
                error: 'LDAP read failed: ' + e.message
            };
        }

        // ── Step 2: Identify accounts where password/account expires ──────
        const entriesToUpdate = [];
        let alreadyNeverExpires = 0;

        for (const entry of entries) {
            const uac = parseInt(entry.userAccountControl, 10) || 512;
            const passwordExpires = (uac & UF_DONT_EXPIRE_PASSWD) === 0;

            const accExpires = entry.accountExpires ? entry.accountExpires.toString() : '0';
            const hasAccountExpiration = accExpires !== '0' && accExpires !== '9223372036854775807';

            if (passwordExpires || hasAccountExpiration) {
                const changes = [];
                const oldVals = {};
                const newVals = {};

                if (passwordExpires) {
                    const newUac = (uac | UF_DONT_EXPIRE_PASSWD).toString();
                    changes.push({ type: 'userAccountControl', values: [newUac] });
                    oldVals.userAccountControl = uac;
                    newVals.userAccountControl = newUac;
                }

                if (hasAccountExpiration) {
                    changes.push({ type: 'accountExpires', values: ['0'] });
                    oldVals.accountExpires = accExpires;
                    newVals.accountExpires = '0';
                }

                entriesToUpdate.push({
                    dn: entry.dn,
                    account: entry.sAMAccountName || entry.cn || entry.dn,
                    changes,
                    old: oldVals,
                    new: newVals
                });
            } else {
                alreadyNeverExpires++;
            }
        }

        // ── Step 3: Apply changes with devMode limitation ─────────────────
        const { items: toProcess } = devModeUtils.limitInDevMode(entriesToUpdate);

        const applied = [];
        const errors = [];

        for (const item of toProcess) {
            try {
                await this._writeLdapAttributes(ldapConfig, item.dn, item.changes);
                applied.push({
                    id: item.account,
                    old: item.old,
                    new: item.new
                });
            } catch (e) {
                errors.push({
                    id: item.account,
                    message: e.message
                });
            }
        }

        return {
            success: true,
            devMode,
            details: {
                totalStudents: entries.length,
                alreadyNeverExpires,
                totalPending: entriesToUpdate.length,
                changed: applied,
                errors,
                skipped: entriesToUpdate.length - toProcess.length
            }
        };
    }

    /**
     * Reads all student entries from LDAP base
     */
    _readStudentEntries(ldapConfig) {
        return new Promise((resolve, reject) => {
            const client = ldap.createClient({
                url: ldapConfig.url,
                tlsOptions: { rejectUnauthorized: false }
            });

            client.on('error', (err) => {
                reject(new Error('LDAP Connection Error: ' + err.message));
            });

            const bindDN = ldapConfig.user || ldapConfig.binddn;
            const bindPW = ldapConfig.password || ldapConfig.bindpw;

            client.bind(bindDN, bindPW, (err) => {
                if (err) {
                    client.unbind();
                    return reject(new Error('LDAP Bind Error: ' + err.message));
                }

                const baseDN = ldapConfig.studentUserbase || ldapConfig.basedn;
                if (!baseDN) {
                    client.unbind();
                    return reject(new Error('LDAP studentUserbase / basedn missing'));
                }

                const opts = {
                    filter: ldapConfig.userfilter || '(&(objectClass=user)(!(objectClass=computer)))',
                    scope: 'sub',
                    attributes: ['dn', 'sAMAccountName', 'cn', 'userAccountControl', 'accountExpires']
                };

                client.search(baseDN, opts, (err, searchRes) => {
                    if (err) {
                        client.unbind();
                        return reject(new Error('LDAP Search Error: ' + err.message));
                    }

                    const entries = [];

                    searchRes.on('searchEntry', (entry) => {
                        const dn = entry.objectName || null;

                        let obj;
                        if (entry.object) {
                            obj = entry.object;
                        } else {
                            obj = {};
                            if (entry.attributes) {
                                entry.attributes.forEach(attr => {
                                    obj[attr.type] = attr.values && attr.values.length === 1
                                        ? attr.values[0]
                                        : attr.values;
                                });
                            }
                        }

                        const sAMAccountName = (Array.isArray(obj.sAMAccountName) ? obj.sAMAccountName[0] : obj.sAMAccountName || '').trim();
                        const cn = (Array.isArray(obj.cn) ? obj.cn[0] : obj.cn || '').trim();
                        const userAccountControl = Array.isArray(obj.userAccountControl) ? obj.userAccountControl[0] : obj.userAccountControl;
                        const accountExpires = Array.isArray(obj.accountExpires) ? obj.accountExpires[0] : obj.accountExpires;

                        entries.push({
                            dn,
                            sAMAccountName,
                            cn,
                            userAccountControl,
                            accountExpires
                        });
                    });

                    searchRes.on('end', () => {
                        client.unbind();
                        resolve(entries);
                    });

                    searchRes.on('error', (err) => {
                        client.unbind();
                        reject(new Error('LDAP Search Stream Error: ' + err.message));
                    });
                });
            });
        });
    }

    /**
     * Decodes hex-escaped UTF-8 byte sequences in LDAP DN strings.
     */
    _unescapeDN(dnStr) {
        return dnStr.replace(/(\\[0-9a-fA-F]{2})+/g, (match) => {
            const bytes = [];
            for (let i = 0; i < match.length; i += 3) {
                bytes.push(parseInt(match.substr(i + 1, 2), 16));
            }
            return Buffer.from(bytes).toString('utf8');
        });
    }

    /**
     * Writes attribute modifications to an LDAP entry using manual ModifyRequest
     * to avoid ldapjs parseDN escaping issues with non-ASCII characters.
     */
    _writeLdapAttributes(ldapConfig, dn, changes) {
        return new Promise((resolve, reject) => {
            const client = ldap.createClient({
                url: ldapConfig.url,
                tlsOptions: { rejectUnauthorized: false }
            });

            client.on('error', (err) => {
                reject(new Error('LDAP Connection Error: ' + err.message));
            });

            const bindDN = ldapConfig.user || ldapConfig.binddn;
            const bindPW = ldapConfig.password || ldapConfig.bindpw;

            client.bind(bindDN, bindPW, (err) => {
                if (err) {
                    client.unbind();
                    return reject(new Error('LDAP Bind Error: ' + err.message));
                }

                const ldapChanges = changes.map(c => new ldap.Change({
                    operation: 'replace',
                    modification: {
                        type: c.type,
                        values: c.values
                    }
                }));

                const dnStr = this._unescapeDN(dn.toString());
                const req = new ldap.ModifyRequest();
                req.object = dnStr;
                req.changes = ldapChanges;

                client._send(req, [ldap.LDAPResult], null, (err) => {
                    client.unbind();
                    if (err) {
                        return reject(new Error(`LDAP Modify Error for ${dnStr}: ${err.message}`));
                    }
                    resolve();
                });
            });
        });
    }

    format(report) {
        if (!report || !report.details) return '-';

        let html = '';
        const suffix = devModeUtils.devModeSuffix(report.devMode);
        const details = report.details;

        const changedCount = details.changed ? details.changed.length : 0;
        const totalPending = details.totalPending || 0;
        const neverExpiresCount = details.alreadyNeverExpires || 0;

        if (changedCount > 0) {
            html += `<div style="color: var(--wa-color-success-600); font-weight: bold;">${changedCount}/${totalPending} Kennwortablauf aufgehoben${suffix}</div>`;
        } else if (totalPending === 0) {
            html += `<div style="color:var(--wa-color-neutral-500)">Alle Kennwörter ohne Ablaufdatum (${neverExpiresCount})${suffix}</div>`;
        } else {
            html += `<div style="color:var(--wa-color-neutral-500)">Keine Konten aktualisiert${suffix}</div>`;
        }

        if (details.errors && details.errors.length > 0) {
            html += `<div style="color:var(--wa-color-danger-600); font-size: 0.9em;">${details.errors.length} Fehler</div>`;
        }

        return html;
    }
}

module.exports = PaedmlFixPasswordExpirationTask;
