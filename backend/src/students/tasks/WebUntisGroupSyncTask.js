const Task = require('../../tasks/Task');
const { getDomain } = require('../../domains/registry');
const { isDevMode } = require('../../utils/devMode');
const config = require('../../config');

/**
 * Synchronises student user groups in WebUntis:
 * - Students >= 18 without Attestpflicht (medicalReportDuty) are assigned to 'Schüler*innen Ü18'.
 * - All other students are assigned to 'Schüler*innen'.
 * 
 * Works completely in-memory without storing student entities in MongoDB.
 * Adheres to DevMode limit (max 1 modification when devMode is active).
 */
class WebUntisGroupSyncTask extends Task {
    constructor() {
        super('web-untis-group-sync');
    }

    async execute(parameters = {}) {
        const devMode = isDevMode();
        let untis = getDomain('webuntis');
        if (!untis) {
            const { domains } = require('../../domains');
            untis = domains?.webuntis;
            if (untis) {
                const { registerDomain } = require('../../domains/registry');
                registerDomain(untis);
            }
        }

        if (!untis) {
            throw new Error('Domain webuntis not found');
        }

        const rolesConfig = config.webuntisRoles || {};
        const adultGroupName = rolesConfig.adultGroup || 'Schüler*innen Ü18';
        const defaultGroupName = rolesConfig.defaultGroup || 'Schüler*innen';
        const ignoredList = (rolesConfig.ignoredStudents || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
        const ignoredSet = new Set(ignoredList);

        console.log(`[WebUntisGroupSyncTask] Reading students from WebUntis...`);
        const students = await untis.readIdentities();
        console.log(`[WebUntisGroupSyncTask] Fetched ${students.length} students.`);

        const today = new Date();
        const adultTargetLogins = new Set();
        const defaultTargetLogins = new Set();
        const skipped = [];

        for (const student of students) {
            const userId = (student.userId || '').trim();
            if (!userId) {
                skipped.push({ reason: 'no_userid', name: `${student.firstName} ${student.lastName}` });
                continue;
            }

            if (userId.toUpperCase().endsWith('_OLD')) {
                skipped.push({ reason: 'suffix_old', userId });
                continue;
            }

            if (ignoredSet.has(userId.toLowerCase())) {
                skipped.push({ reason: 'ignored_config', userId });
                continue;
            }

            let isAdult = false;
            if (student.birthday) {
                const birth = new Date(student.birthday);
                if (!isNaN(birth.getTime())) {
                    const turnsAdult = new Date(birth.getFullYear() + 18, birth.getMonth(), birth.getDate());
                    isAdult = turnsAdult <= today;
                }
            }

            const hasDuty = !!student.medicalReportDuty;

            if (isAdult && !hasDuty) {
                adultTargetLogins.add(userId.toLowerCase());
            } else {
                defaultTargetLogins.add(userId.toLowerCase());
            }
        }

        console.log(`[WebUntisGroupSyncTask] Classification: ${adultTargetLogins.size} Ü18 target, ${defaultTargetLogins.size} Default target, ${skipped.length} skipped.`);

        // Read groups from WebUntis
        const groups = await untis.readUserGroups();
        const adultRef = groups.find(g => g.name === adultGroupName || g.name.toLowerCase() === adultGroupName.toLowerCase());
        const defaultRef = groups.find(g => g.name === defaultGroupName || g.name.toLowerCase() === defaultGroupName.toLowerCase());

        if (!adultRef) {
            throw new Error(`Group '${adultGroupName}' not found in WebUntis`);
        }
        if (!defaultRef) {
            throw new Error(`Group '${defaultGroupName}' not found in WebUntis`);
        }

        console.log(`[WebUntisGroupSyncTask] Reading group details for '${adultGroupName}' (ID ${adultRef.id}) and '${defaultGroupName}' (ID ${defaultRef.id})...`);
        const [adultGroup, defaultGroup] = await Promise.all([
            untis.readUserGroup(adultRef.id),
            untis.readUserGroup(defaultRef.id)
        ]);

        // Map logins to WebUntis numeric option IDs
        const byLabel = new Map();
        for (const opt of adultGroup.options) {
            if (opt.label) byLabel.set(String(opt.label).toLowerCase(), opt.id);
        }
        for (const opt of defaultGroup.options) {
            if (opt.label && !byLabel.has(String(opt.label).toLowerCase())) {
                byLabel.set(String(opt.label).toLowerCase(), opt.id);
            }
        }

        const adultDesiredIds = new Set();
        const unresolvedAdult = [];
        for (const login of adultTargetLogins) {
            const optId = byLabel.get(login);
            if (optId !== undefined) adultDesiredIds.add(optId);
            else unresolvedAdult.push(login);
        }

        const defaultDesiredIds = new Set();
        const unresolvedDefault = [];
        for (const login of defaultTargetLogins) {
            const optId = byLabel.get(login);
            if (optId !== undefined) defaultDesiredIds.add(optId);
            else unresolvedDefault.push(login);
        }

        const adultCurrentIds = new Set(adultGroup.memberIds);
        const defaultCurrentIds = new Set(defaultGroup.memberIds);

        // In WebUntis group membership is exclusive:
        // Moving to Ü18: Add to adultGroup
        const toAddToAdult = [...adultDesiredIds].filter(id => !adultCurrentIds.has(id));

        // Moving back to Standard: Students currently in Ü18 that belong in defaultGroup
        const toMoveBackToDefault = [...adultCurrentIds].filter(id => defaultDesiredIds.has(id));
        // Also students who belong to defaultGroup and currently have no group at all
        const unassignedToDefault = [...defaultDesiredIds].filter(id => !defaultCurrentIds.has(id) && !adultCurrentIds.has(id));
        const toAddToDefault = [...new Set([...toMoveBackToDefault, ...unassignedToDefault])];

        console.log(`[WebUntisGroupSyncTask] Pending assignments: +${toAddToAdult.length} to '${adultGroupName}', +${toAddToDefault.length} to '${defaultGroupName}'.`);

        // Apply DevMode limit: maximum 1 change when devMode is active
        let adultBatch = toAddToAdult;
        let defaultBatch = toAddToDefault;
        let limited = false;

        if (devMode) {
            const totalPending = toAddToAdult.length + toAddToDefault.length;
            if (totalPending > 1) {
                limited = true;
                if (toAddToAdult.length > 0) {
                    adultBatch = toAddToAdult.slice(0, 1);
                    defaultBatch = [];
                } else {
                    adultBatch = [];
                    defaultBatch = toAddToDefault.slice(0, 1);
                }
            }
        }

        const updated = [];
        const errors = [];

        if (adultBatch.length > 0) {
            try {
                const newIds = [...new Set([...adultCurrentIds, ...adultBatch])];
                await untis.writeUserGroupMembers(adultGroup, newIds);
                updated.push({ group: adultGroupName, addedCount: adultBatch.length, total: newIds.length });
                console.log(`[WebUntisGroupSyncTask] Updated '${adultGroupName}': +${adultBatch.length} (total: ${newIds.length})${limited ? ' [DevMode Limit]' : ''}`);
            } catch (e) {
                errors.push({ group: adultGroupName, message: e.message });
                console.error(`[WebUntisGroupSyncTask] Error updating '${adultGroupName}':`, e.message);
            }
        }

        if (defaultBatch.length > 0) {
            try {
                const newIds = [...new Set([...defaultCurrentIds, ...defaultBatch])];
                await untis.writeUserGroupMembers(defaultGroup, newIds);
                updated.push({ group: defaultGroupName, addedCount: defaultBatch.length, total: newIds.length });
                console.log(`[WebUntisGroupSyncTask] Updated '${defaultGroupName}': +${defaultBatch.length} (total: ${newIds.length})${limited ? ' [DevMode Limit]' : ''}`);
            } catch (e) {
                errors.push({ group: defaultGroupName, message: e.message });
                console.error(`[WebUntisGroupSyncTask] Error updating '${defaultGroupName}':`, e.message);
            }
        }

        return {
            success: errors.length === 0,
            devMode,
            details: {
                limited,
                totalStudents: students.length,
                adultCount: adultTargetLogins.size,
                defaultCount: defaultTargetLogins.size,
                adultGroup: {
                    name: adultGroupName,
                    current: adultCurrentIds.size,
                    pending: toAddToAdult.length,
                    written: adultBatch.length
                },
                defaultGroup: {
                    name: defaultGroupName,
                    current: defaultCurrentIds.size,
                    pending: toAddToDefault.length,
                    written: defaultBatch.length
                },
                updated,
                errors
            }
        };
    }

    format(report) {
        if (!report) return '-';
        if (report.success === false) {
            return `<div style="color:var(--wa-color-danger-600)">Fehler: ${report.error || report.details?.errors?.[0]?.message || 'Unbekannter Fehler'}</div>`;
        }

        const d = report.details || {};
        const parts = [];
        if (d.adultGroup?.written > 0) {
            parts.push(`<span style="color:var(--wa-color-success-600)">+${d.adultGroup.written} in '${d.adultGroup.name}'</span>`);
        }
        if (d.defaultGroup?.written > 0) {
            parts.push(`<span style="color:var(--wa-color-neutral-800)">+${d.defaultGroup.written} in '${d.defaultGroup.name}'</span>`);
        }

        if (parts.length === 0) {
            parts.push('<span style="color:var(--wa-color-neutral-500)">Keine Änderungen nötig (bereits synchron)</span>');
        }

        let msg = `<div>${parts.join(', ')}`;
        if (d.limited || report.devMode) {
            msg += ` <span style="color:var(--wa-color-warning-600); font-size:0.9em;">(DevMode${d.limited ? ' Limit: 1' : ''})</span>`;
        }
        msg += `</div>`;
        return msg;
    }
}

module.exports = WebUntisGroupSyncTask;
