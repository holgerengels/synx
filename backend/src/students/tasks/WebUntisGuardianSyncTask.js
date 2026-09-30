const Task = require('../../tasks/Task');
const { getDomain } = require('../../domains/registry');
const { isDevMode, limitInDevMode, devModeSuffix } = require('../../utils/devMode');

class WebUntisGuardianSyncTask extends Task {
    constructor() {
        super('web-untis-guardian-sync');
    }

    async execute(parameters = {}) {
        const devMode = isDevMode();
        const asv = getDomain('asv');
        const untis = getDomain('webuntis');

        console.log('[Guardian Sync] Starting WebUntisGuardianSyncTask...');
        console.log('[Guardian Sync] Fetching guardians in parallel from ASV and WebUntis...');
        const [asvGuardians, untisGuardians] = await Promise.all([
            asv.readGuardians(),
            untis.readGuardians()
        ]);
        console.log(`[Guardian Sync] Fetched ${asvGuardians.length} guardians from ASV, ${untisGuardians.length} from WebUntis.`);

        const untisMap = {};
        for (const ug of untisGuardians) {
            if (ug.email) {
                untisMap[ug.email.toLowerCase()] = ug;
            }
        }

        const additions = [];
        const updates = [];

        for (const guardian of asvGuardians) {
            const email = guardian.email;
            if (!email) continue;
            
            const studentAccounts = guardian.students.map(s => s.account);
            
            const untisG = untisMap[email];
            if (!untisG) {
                additions.push({ guardian, studentAccounts });
            } else {
                const untisStudentAccounts = untisG.students.map(s => s.account);
                let needsUpdate = false;
                const reasons = [];
                const missingStudents = studentAccounts.filter(acc => !untisStudentAccounts.includes(acc));
                
                if (guardian.lastName !== untisG.lastName || guardian.firstName !== untisG.firstName) {
                    needsUpdate = true;
                    reasons.push(`Name: ASV="${guardian.firstName} ${guardian.lastName}" vs WebUntis="${untisG.firstName} ${untisG.lastName}"`);
                }
                if (missingStudents.length > 0) {
                    needsUpdate = true;
                    reasons.push(`Missing students in WebUntis: [${missingStudents.join(', ')}] (ASV has: [${studentAccounts.join(', ')}], WebUntis has: [${untisStudentAccounts.join(', ')}])`);
                }

                if (needsUpdate) {
                    console.log(`[Guardian Sync] Update needed for ${email}: ${reasons.join('; ')}`);
                    // Inject the ID from WebUntis so we update the correct mapped record
                    guardian.id = untisG.id;
                    updates.push({ guardian, studentAccounts });
                }
            }
        }

        const { items: addsToProcess } = limitInDevMode(additions);
        const { items: updatesToProcess } = limitInDevMode(updates);

        const addedLog = [];
        const updatedLog = [];
        const errorLog = [];

        for (const req of addsToProcess) {
            try {
                await untis.changeGuardian(req.guardian, req.studentAccounts);
                addedLog.push({ id: req.guardian.email, new: req.guardian, newStudents: req.studentAccounts });
            } catch (e) {
                errorLog.push({ id: req.guardian.email, message: `Add Error: ${e.message}` });
            }
        }

        for (const req of updatesToProcess) {
            try {
                await untis.changeGuardian(req.guardian, req.studentAccounts);
                // We should theoretically find the old guardian object in untisMap
                const oldGuardian = untisMap[req.guardian.email];
                updatedLog.push({ id: req.guardian.email, old: oldGuardian, new: req.guardian, newStudents: req.studentAccounts });
            } catch (e) {
                errorLog.push({ id: req.guardian.email, message: `Update Error: ${e.message}` });
            }
        }

        return {
             success: true,
             devMode,
             details: {
                 totalAdditionsDiscovered: additions.length,
                 totalUpdatesDiscovered: updates.length,
                 added: addedLog,
                 changed: updatedLog,
                 errors: errorLog
             }
        };
    }
}

module.exports = WebUntisGuardianSyncTask;
