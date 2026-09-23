const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const Identity = require('../../domains/Identity');
const { encode, next } = require('../../utils/userIds');
const Domain = require('../../domains/Domain');

const config = require('../../config');

class ASV extends Domain {
    get supportedProperties() { return ['userId', 'firstName', 'lastName', 'birthday', 'clazz']; }
    get cacheTTL() { return 3600000; } // 1 hour

    constructor() {
        super('asv');
        const asvConfig = config.asv || {};
        const host = asvConfig.host || process.env.ASV_HOST;
        const port = asvConfig.port || process.env.ASV_PORT;
        const database = asvConfig.name || process.env.ASV_DB;
        const user = asvConfig.user || process.env.ASV_USER;
        const password = asvConfig.password || process.env.ASV_PASSWORD;
        
        if (!host || !port || !database || !user || !password) {
            throw new Error('ASV Database configuration is incomplete. Missing host, port, name, user, or password.');
        }

        this.pool = new Pool({ host, port, database, user, password });
        
        this.schuljahr = asvConfig.schuljahr;
        if (!this.schuljahr) throw new Error('ASV schuljahr missing');
        this.lag = asvConfig.lag || '30 days';
    }

    mapClass(className) {
        if (!className || typeof className !== 'string') return className;
        const mappings = config.classMapping || [];
        for (const item of mappings) {
            if (!item || typeof item !== 'object') continue;
            for (const [key, value] of Object.entries(item)) {
                if (key.toLowerCase() === className.toLowerCase()) {
                    return value;
                }
            }
        }
        return className;
    }

    async readIdentities() {
        let client;
        try {
            client = await this.pool.connect();
        } catch (e) {
            // console.error('ASV DB Connection failed:', e.message);
            throw new Error('ASV DB Connection failed: ' + e.message);
        }
        
        try {
            // First get classes
            const classRes = await client.query(`
                select k.id, k.klassenname
                from asv.svp_klasse k
                where k.schule_schuljahr_id in (
                    select ss.id from asv.svp_wl_schuljahr sj, asv.svp_schule_schuljahr ss
                    where sj.id = ss.schuljahr_id and sj.kurzform = $1
                )
                and k.wl_klassenart_id in (
                    select id from asv.svp_wl_wert
                    where werteliste_id in (
                        select id from asv.svp_wl_werteliste where bezeichnung = 'KLASSENART'
                    )
                    and kurzform != 'ORG'
                )
            `, [this.schuljahr]);
            const classes = {};
            classRes.rows.forEach(r => {
                if (!r.klassenname.includes('-')) {
                    classes[r.id] = this.mapClass(r.klassenname);
                }
            });

            // Get genders map
            const genderRes = await client.query(`
                select w.id, w.kurzform from asv.svp_wl_wert w
                where w.werteliste_id in (select id from asv.svp_wl_werteliste where bezeichnung = 'GESCHLECHT')
            `);
            const genders = {};
            genderRes.rows.forEach(r => {
                genders[r.id] = (r.kurzform || '').toUpperCase();
            });

            // Get student identities
            const studentRes = await client.query(`
                select u.userid, s.vornamen, s.familienname, s.wl_geschlecht_id, s.geburtsdatum, kg.klasse_id
                from asv.svp_schueler_stamm s, sync.user_id u, asv.svp_schueler_schuljahr sj, asv.svp_klassengruppe kg
                where s.id in (
                    select schueler_stamm_id from asv.svp_schueler_schuljahr where schuljahr_id in (
                        select id from asv.svp_wl_schuljahr where kurzform = $1
                    )
                )
                and (s.austrittsdatum is null or s.austrittsdatum > date(now() - $2::interval))
                and sj.schueler_stamm_id = s.id
                and sj.klassengruppe_id = kg.id
                and u.id = s.id
            `, [this.schuljahr, this.lag]);

            const identities = [];
            for (const r of studentRes.rows) {
                const clazz = classes[r.klasse_id];
                if (clazz) {
                    identities.push(new Identity(
                        r.userid,
                        r.vornamen,
                        r.familienname,
                        {
                            birthday: r.geburtsdatum ? `${r.geburtsdatum.getFullYear()}-${String(r.geburtsdatum.getMonth() + 1).padStart(2, '0')}-${String(r.geburtsdatum.getDate()).padStart(2, '0')}` : null,
                            clazz: clazz,
                            gender: genders[r.wl_geschlecht_id] || ''
                        }
                    ));
                }
            }
            return identities;
        } catch(e) {
            console.error('ASV query failed', e);
            throw new Error('ASV query failed: ' + e.message);
        } finally {
            client.release();
        }
    }

    /**
     * Read-only: Returns students that don't have a user ID yet.
     * @returns {Array<{id: string, firstName: string, lastName: string}>}
     */
    async readStudentsWithoutIds() {
        let client;
        try {
            client = await this.pool.connect();
        } catch (e) {
            throw new Error('ASV DB Connection failed: ' + e.message);
        }

        try {
            const missingRes = await client.query(`
                select id, vornamen, familienname 
                from asv.svp_schueler_stamm 
                where id not in (select id from sync.user_id)
            `);

            return missingRes.rows.map(r => ({
                id: r.id,
                firstName: r.vornamen,
                lastName: r.familienname
            }));
        } catch(e) {
            console.error('ASV readStudentsWithoutIds failed', e);
            throw new Error('ASV readStudentsWithoutIds failed: ' + e.message);
        } finally {
            client.release();
        }
    }

    /**
     * Generate a unique userId for a student and write it to the database.
     * @returns {{id: string, account: string, firstName: string, lastName: string}}
     */
    async writeGeneratedId(student) {
        let client;
        try {
            client = await this.pool.connect();
        } catch (e) {
            throw new Error('ASV DB Connection failed: ' + e.message);
        }

        try {
            const len = config.account?.maxlength || 18;

            let like = encode(student.lastName);
            if (like.length > len - 6) {
                like = like.substring(0, len - 6);
            }

            // Fetch similar userids to avoid collisions
            const similarRes = await client.query(`
                select userid from sync.user_id where userid like $1
            `, [like + '%']);

            const similar = similarRes.rows.map(r => r.userid);
            const userid = next(len, similar, student.firstName, student.lastName);

            // Insert new userid mapping
            await client.query(`
                insert into sync.user_id (id, userid) values ($1, $2)
            `, [student.id, userid]);

            return { id: student.id, account: userid, firstName: student.firstName, lastName: student.lastName };
        } catch(e) {
            console.error(`ASV writeGeneratedId failed for ${student.id}`, e);
            throw new Error(`ASV writeGeneratedId failed for ${student.id}: ${e.message}`);
        } finally {
            client.release();
        }
    }
    async readExitDates(usernames) {
        if (!usernames || usernames.length === 0) return {};
        
        const client = await this.pool.connect();
        try {
            const query = `
                select u.userid, s.austrittsdatum
                from asv.svp_schueler_stamm s, sync.user_id u
                where s.austrittsdatum <= date(now())
                and u.id = s.id
                and u.userid = ANY($1::varchar[])
            `;
            
            const res = await client.query(query, [usernames]);
            
            const map = {};
            for (const row of res.rows) {
                if (row.austrittsdatum) {
                     map[row.userid] = row.austrittsdatum.toISOString().split('T')[0];
                }
            }
            return map;
        } catch (e) {
            console.error('ASV readExitDates failed', e);
            throw new Error('ASV readExitDates failed: ' + e.message);
        } finally {
            client.release();
        }
    }

    async readGuardians() {
        let client;
        try {
            client = await this.pool.connect();
        } catch (e) {
            // console.error('ASV DB Connection failed:', e.message);
            throw new Error('ASV DB Connection failed: ' + e.message);
        }

        try {
            // First get classes to resolve klasse_id
            const classRes = await client.query(`
                select k.id, k.klassenname
                from asv.svp_klasse k
                where k.schule_schuljahr_id in (
                    select ss.id from asv.svp_wl_schuljahr sj, asv.svp_schule_schuljahr ss
                    where sj.id = ss.schuljahr_id and sj.kurzform = $1
                )
                and k.wl_klassenart_id in (
                    select id from asv.svp_wl_wert
                    where werteliste_id in (
                        select id from asv.svp_wl_werteliste where bezeichnung = 'KLASSENART'
                    )
                    and kurzform != 'ORG'
                )
            `, [this.schuljahr]);
            const classes = {};
            classRes.rows.forEach(r => {
                if (!r.klassenname.includes('-')) {
                    classes[r.id] = this.mapClass(r.klassenname);
                }
            });

            // Get guardians
            const guardianRes = await client.query(`
                SELECT DISTINCT u.userid, ss.vornamen as student_firstname, ss.familienname as student_lastname, 
                                p.vornamen as guardian_firstname, p.familienname as guardian_lastname, 
                                k.kommunikationsadresse as email, kg.klasse_id
                FROM asv.svp_kommunikation k, asv.svp_person_kommunikation pk, asv.svp_schueler_anschrift sa, 
                     asv.svp_schueler_stamm ss, asv.svp_schueler_schuljahr sj, asv.svp_klassengruppe kg, 
                     asv.svp_person p, sync.user_id u
                WHERE k.id = pk.kommunikation_id
                  AND pk.person_id = sa.person_id
                  AND pk.person_id = p.id
                  AND sa.schueler_stamm_id = ss.id
                  AND sj.schueler_stamm_id = ss.id
                  AND sj.klassengruppe_id = kg.id
                  AND k.wl_kommunikationstyp_id = '2087_7'
                  AND (ss.austrittsdatum is null or ss.austrittsdatum > date(now() - $2::interval))
                  AND ss.id in (
                    select schueler_stamm_id from asv.svp_schueler_schuljahr where schuljahr_id in (
                      select id from asv.svp_wl_schuljahr where kurzform = $1
                    )
                  )
                  AND u.id = ss.id
            `, [this.schuljahr, this.lag]);

            const map = {}; // map guardians by email
            const guardians = [];

            for (const r of guardianRes.rows) {
                const clazz = classes[r.klasse_id];
                if (!clazz) continue; // Filter students without a valid class

                const email = (r.email || '').trim().toLowerCase();
                if (!email) continue;
                
                let guardian = map[email];
                if (!guardian) {
                    guardian = {
                        id: null,
                        email: email,
                        firstName: r.guardian_firstname,
                        lastName: r.guardian_lastname,
                        students: []
                    };
                    guardians.push(guardian);
                    map[email] = guardian;
                }

                // Add student to the guardian
                // Only add if not already present to avoid duplicates from the database
                if (!guardian.students.find(s => s.account === r.userid)) {
                    guardian.students.push({
                        account: r.userid,
                        firstName: r.student_firstname,
                        lastName: r.student_lastname,
                        clazz: clazz
                    });
                }
            }

            return guardians;
        } catch(e) {
            console.error('ASV query failed for guardians', e);
            throw new Error('ASV query failed for guardians: ' + e.message);
        } finally {
            client.release();
        }
    }

    /**
     * Rename a student's user ID in ASV (sync.user_id table).
     * @param {string} oldUserId
     * @param {string} newUserId
     * @returns {Promise<{success: boolean, oldUserId: string, newUserId: string}>}
     */
    async renameIdentity(oldUserId, newUserId) {
        if (!oldUserId || !newUserId) {
            throw new Error('Alte und neue User-ID müssen angegeben werden.');
        }
        if (oldUserId === newUserId) {
            throw new Error('Alte und neue User-ID dürfen nicht identisch sein.');
        }

        let client;
        try {
            client = await this.pool.connect();
        } catch (e) {
            throw new Error('ASV DB Connection failed: ' + e.message);
        }

        try {
            // Check if oldUserId exists
            const oldCheck = await client.query('SELECT id, userid FROM sync.user_id WHERE userid = $1', [oldUserId]);
            if (oldCheck.rows.length === 0) {
                throw new Error(`User-ID '${oldUserId}' existiert nicht in ASV.`);
            }

            // Check if newUserId is already taken
            const newCheck = await client.query('SELECT id, userid FROM sync.user_id WHERE userid = $1', [newUserId]);
            if (newCheck.rows.length > 0) {
                throw new Error(`User-ID '${newUserId}' ist in ASV bereits vergeben.`);
            }

            // Perform rename
            await client.query('UPDATE sync.user_id SET userid = $1 WHERE userid = $2', [newUserId, oldUserId]);

            this.invalidate();

            return {
                success: true,
                oldUserId,
                newUserId
            };
        } catch (e) {
            console.error(`ASV renameIdentity failed from ${oldUserId} to ${newUserId}:`, e.message);
            throw e;
        } finally {
            client.release();
        }
    }
}

module.exports = new ASV();
