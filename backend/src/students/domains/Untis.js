const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const Identity = require('../../domains/Identity');
const ManagableDomain = require('../../domains/ManagableDomain');

const config = require('../../config');

class Untis extends ManagableDomain {
    get supportedProperties() { return ['userId', 'firstName', 'lastName', 'birthday', 'gender', 'clazz']; }
    get cacheTTL() { return 3600000; } // 1 hour

    constructor() {
        super('untis');
        const c = config.untis || {};
        const host = c.host || process.env.UNTIS_HOST;
        const port = c.port || process.env.UNTIS_PORT;
        const database = c.name || process.env.UNTIS_DB;
        const user = c.user || process.env.UNTIS_USER;
        const password = c.password || process.env.UNTIS_PASSWORD;

        if (!host || !port || !database || !user || !password) {
            throw new Error('Untis Database configuration is incomplete. Missing host, port, name, user, or password.');
        }

        this.dbConfig = { host, port, database, user, password };

        this.schulid = c.schulid;
        this.version = c.version;
        this.schuljahr = c.schuljahr;

        if (!this.schulid || !this.version || !this.schuljahr) {
            throw new Error('Untis configuration is incomplete. Missing schulid, version, or schuljahr.');
        }
    }

    async readIdentities() {
        let connection;
        try {
            connection = await mysql.createConnection(this.dbConfig);
        } catch (e) {
            throw new Error('Untis DB Connection failed: ' + e.message);
        }

        try {
            const [classRows] = await connection.execute(
                "SELECT CLASS_ID, Name FROM Class where SCHOOL_ID = ? and VERSION_ID = ? AND SCHOOLYEAR_ID = ?",
                [this.schulid, this.version, this.schuljahr]
            );
            const classes = {};
            classRows.forEach(r => classes[r.CLASS_ID] = r.Name);

            const [studentRows] = await connection.execute(
                "SELECT distinct s.STUDENT_ID, s.Name, s.FirstName, s.Longname, s.Flags, s.BirthDate, s.CLASS_ID FROM Student s where s.SCHOOL_ID = ? and s.VERSION_ID = ? and s.SCHOOLYEAR_ID = ?",
                [this.schulid, this.version, this.schuljahr]
            );

            return studentRows.map(r => {
                let birthday = null;
                if (r.BirthDate && r.BirthDate.toString() !== '0') {
                    const str = r.BirthDate.toString();
                    if (str.length === 8) {
                        const year = parseInt(str.substring(0, 4), 10);
                        const month = parseInt(str.substring(4, 6), 10) - 1;
                        const day = parseInt(str.substring(6, 8), 10);
                        const d = new Date(Date.UTC(year, month, day));
                        birthday = d.toISOString().split('T')[0];
                    }
                }
                let gender = null;
                if (r.Flags) {
                    if (r.Flags.includes('M')) gender = 'M';
                    else if (r.Flags.includes('W')) gender = 'W';
                }
                return new Identity(
                    r.Name, // userId mapped to Name in Untis
                    r.FirstName,
                    r.Longname,
                    {
                        id: r.STUDENT_ID,
                        birthday: birthday,
                        gender: gender,
                        clazz: classes[r.CLASS_ID]
                    }
                );
            }).filter(id => id.userId);
        } catch(e) {
            console.error('Untis query failed', e);
            throw new Error('Untis query failed: ' + e.message);
        } finally {
            if (connection) await connection.end();
        }
    }

    async changeIdentity(identity) {
        let connection;
        try {
            connection = await mysql.createConnection(this.dbConfig);
        } catch (e) {
            throw new Error('Untis DB Connection failed: ' + e.message);
        }

        try {
            let birthDateStr = null;
            if (identity.birthday) {
                birthDateStr = identity.birthday.replace(/-/g, '');
            }

            let flags = null;
            if (identity.gender === 'M') flags = 'M';
            else if (identity.gender === 'W') flags = 'W';

            await connection.execute(
                "UPDATE Student s SET s.FirstName = ?, s.Longname = ?, s.Flags = ?, s.BirthDate = ? WHERE s.SCHOOL_ID = ? AND s.VERSION_ID = ? AND s.Name = ?",
                [identity.firstName, identity.lastName, flags, birthDateStr, this.schulid, this.version, identity.userId]
            );

            this.invalidate();
        } catch (e) {
            console.error('Untis update query failed', e);
            throw new Error('Untis update query failed: ' + e.message);
        } finally {
            if (connection) await connection.end();
        }
    }

    /**
     * Checks if any Untis clients are currently logged in and returns active session details.
     * @returns {Promise<{active: boolean, count: number, sessions: Array<{user: string, workstation: string, osUser: string, loginAt: string}>}>}
     */
    async hasActiveClients() {
        let connection;
        try {
            connection = await mysql.createConnection(this.dbConfig);
            const [rows] = await connection.execute(
                "SELECT USER_ID, Name, UserInfo, LogInDate, LogInTime FROM User WHERE LoggedIn = 1"
            );
            const sessions = (rows || []).map(r => {
                let workstation = '';
                let osUser = '';
                if (r.UserInfo) {
                    const clean = String(r.UserInfo).replace(/\0/g, '').trim();
                    const parts = clean.split('~');
                    workstation = parts[2] || '';
                    osUser = parts[3] || '';
                }
                let loginAt = '';
                if (r.LogInDate) {
                    const d = String(r.LogInDate);
                    const t = r.LogInTime !== undefined && r.LogInTime !== null ? String(r.LogInTime).padStart(4, '0') : '';
                    if (d.length === 8) {
                        const dateFormatted = `${d.substring(6, 8)}.${d.substring(4, 6)}.${d.substring(0, 4)}`;
                        const timeFormatted = t.length >= 4 ? `${t.substring(0, 2)}:${t.substring(2, 4)}` : t;
                        loginAt = timeFormatted ? `${dateFormatted} ${timeFormatted}` : dateFormatted;
                    }
                }
                return {
                    user: r.Name || 'Unbekannt',
                    workstation,
                    osUser,
                    loginAt
                };
            });

            return {
                active: sessions.length > 0,
                count: sessions.length,
                sessions: sessions
            };
        } catch (e) {
            console.error('Untis hasActiveClients failed', e);
            throw new Error('Untis hasActiveClients failed: ' + e.message);
        } finally {
            if (connection) await connection.end();
        }
    }

    /**
     * Rename a student's user ID (Name, ForeignKey, OldName) in Untis Student table.
     * @param {string} oldUserId
     * @param {string} newUserId
     * @returns {Promise<{success: boolean, oldUserId: string, newUserId: string, affectedRows: number}>}
     */
    async renameIdentity(oldUserId, newUserId) {
        if (!oldUserId || !newUserId) {
            throw new Error('Alte und neue User-ID müssen angegeben werden.');
        }
        if (oldUserId === newUserId) {
            throw new Error('Alte und neue User-ID dürfen nicht identisch sein.');
        }

        let connection;
        try {
            connection = await mysql.createConnection(this.dbConfig);
        } catch (e) {
            throw new Error('Untis DB Connection failed: ' + e.message);
        }

        try {
            // Check if old student exists in Untis
            const [oldRows] = await connection.execute(
                "SELECT COUNT(*) AS cnt FROM Student WHERE SCHOOL_ID = ? AND VERSION_ID = ? AND Name = ?",
                [this.schulid, this.version, oldUserId]
            );
            const oldExists = oldRows && oldRows[0] && Number(oldRows[0].cnt) > 0;
            if (!oldExists) {
                throw new Error(`Schüler:in mit Name '${oldUserId}' existiert nicht in Untis.`);
            }

            // Check if new student name already exists in Untis (collision)
            const [newRows] = await connection.execute(
                "SELECT COUNT(*) AS cnt FROM Student WHERE SCHOOL_ID = ? AND VERSION_ID = ? AND Name = ?",
                [this.schulid, this.version, newUserId]
            );
            const newExists = newRows && newRows[0] && Number(newRows[0].cnt) > 0;
            if (newExists) {
                throw new Error(`Schüler:in mit Name '${newUserId}' existiert bereits in Untis.`);
            }

            // Update Name, ForeignKey, OldName in Student table
            const [result] = await connection.execute(
                "UPDATE Student SET Name = ?, ForeignKey = ?, OldName = ? WHERE SCHOOL_ID = ? AND VERSION_ID = ? AND Name = ?",
                [newUserId, newUserId, oldUserId, this.schulid, this.version, oldUserId]
            );

            this.invalidate();

            return {
                success: true,
                oldUserId,
                newUserId,
                affectedRows: result.affectedRows || 0
            };
        } catch (e) {
            console.error(`Untis renameIdentity failed from ${oldUserId} to ${newUserId}:`, e.message);
            throw e;
        } finally {
            if (connection) await connection.end();
        }
    }
}

module.exports = new Untis();

