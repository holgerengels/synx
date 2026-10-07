const Task = require('../../tasks/Task');
const config = require('../../config');
const devModeUtils = require('../../utils/devMode');
const { getDomain } = require('../../domains/registry');

/**
 * PaedmlSetEmailTask
 *
 * Sets the pseudo email address (<account>@<emailDomain>)
 * for existing student accounts in Schulkonsole via its REST API.
 *
 * Expects config.schulkonsole.emailDomain and throws an error if missing.
 * DevMode: Limits writes in dev mode to prevent mass modifications.
 */
class PaedmlSetEmailTask extends Task {
    constructor() {
        super('paedml-set-email');
    }

    async execute() {
        const emailDomain = config.schulkonsole?.emailDomain;
        if (!emailDomain) {
            throw new Error('Schulkonsole emailDomain missing (config.schulkonsole.emailDomain).');
        }

        const schulkonsole = getDomain('schulkonsole');
        if (!schulkonsole) {
            throw new Error('Schulkonsole domain not available.');
        }

        const devMode = devModeUtils.isDevMode();

        let students;
        try {
            students = await schulkonsole.getIdentities();
        } catch (e) {
            return {
                success: false,
                error: 'Schulkonsole read error: ' + e.message
            };
        }

        const entriesToUpdate = [];
        let alreadySet = 0;

        for (const student of students) {
            const expectedEmail = `${student.userId.toLowerCase()}@${emailDomain}`;
            const currentEmail = (student.email || '').toLowerCase().trim();

            if (!currentEmail || currentEmail !== expectedEmail) {
                entriesToUpdate.push({
                    account: student.userId,
                    student,
                    old: { email: student.email || null },
                    new: { email: expectedEmail }
                });
            } else {
                alreadySet++;
            }
        }

        const { items: toProcess } = devModeUtils.limitInDevMode(entriesToUpdate);
        const applied = [];
        const errors = [];

        for (const item of toProcess) {
            try {
                await schulkonsole.changeIdentity({
                    ...item.student,
                    email: item.new.email
                });
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
                totalStudents: students.length,
                alreadySet,
                totalPending: entriesToUpdate.length,
                changed: applied,
                errors,
                skipped: entriesToUpdate.length - toProcess.length
            }
        };
    }

    format(report) {
        if (!report || !report.details) return '-';

        let html = '';
        const suffix = devModeUtils.devModeSuffix(report.devMode);
        const details = report.details;

        const changedCount = details.changed ? details.changed.length : 0;
        const totalPending = details.totalPending || 0;
        const alreadySetCount = details.alreadySet || 0;

        if (changedCount > 0) {
            html += `<div style="color: var(--wa-color-success-600); font-weight: bold;">${changedCount}/${totalPending} E-Mail-Adressen gesetzt${suffix}</div>`;
        } else if (totalPending === 0) {
            html += `<div style="color:var(--wa-color-neutral-500)">Alle E-Mail-Adressen aktuell (${alreadySetCount})${suffix}</div>`;
        } else {
            html += `<div style="color:var(--wa-color-neutral-500)">Keine Konten aktualisiert${suffix}</div>`;
        }

        if (details.errors && details.errors.length > 0) {
            html += `<div style="color:var(--wa-color-danger-600); font-size: 0.9em;">${details.errors.length} Fehler</div>`;
        }

        return html;
    }
}

module.exports = PaedmlSetEmailTask;
