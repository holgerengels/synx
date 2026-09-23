const Task = require('../../tasks/Task');
const { getDomain } = require('../../domains/registry');
const devModeUtil = require('../../utils/devMode');

class RenameUserIdTask extends Task {
    constructor() {
        super('rename-userid');
    }

    async execute(parameters = {}) {
        const oldUserId = (parameters.oldUserId || '').trim();
        const newUserId = (parameters.newUserId || '').trim();

        if (!oldUserId || !newUserId) {
            throw new Error('Alte und neue User-ID müssen angegeben werden.');
        }

        if (oldUserId === newUserId) {
            throw new Error('Alte und neue User-ID dürfen nicht identisch sein.');
        }

        const untis = getDomain('untis');
        if (untis && typeof untis.hasActiveClients === 'function') {
            const clientStatus = await untis.hasActiveClients();
            if (clientStatus.active) {
                throw new Error(`Untis hat noch aktive Verbindungen (${clientStatus.count} Client(s) eingeloggt). Bitte Untis zuerst schließen.`);
            }
        }

        const devMode = devModeUtil.isDevMode();
        const asv = getDomain('asv');

        const warnings = [
            'WebUntis: Wird bei der nächsten Stammdatenübertragung synchronisiert.',
            'Schulkonsole: Manuelle Umbenennung erforderlich.',
            'Nextcloud: Manuelle Umbenennung erforderlich.',
            'Matrix: Manuelle Umbenennung erforderlich.'
        ];

        if (devMode) {
            return {
                success: true,
                devMode: true,
                dryRun: true,
                oldUserId,
                newUserId,
                details: {
                    asv: { renamed: true, dryRun: true },
                    untis: { renamed: true, dryRun: true },
                    changed: [{ id: oldUserId, old: { userId: oldUserId }, new: { userId: newUserId } }]
                },
                warnings
            };
        }

        // Production / non-devMode execution
        if (!asv || typeof asv.renameIdentity !== 'function') {
            throw new Error("ASV Domain ist nicht verfügbar oder unterstützt 'renameIdentity' nicht.");
        }
        if (!untis || typeof untis.renameIdentity !== 'function') {
            throw new Error("Untis Domain ist nicht verfügbar oder unterstützt 'renameIdentity' nicht.");
        }

        const asvResult = await asv.renameIdentity(oldUserId, newUserId);
        const untisResult = await untis.renameIdentity(oldUserId, newUserId);

        return {
            success: true,
            devMode: false,
            oldUserId,
            newUserId,
            details: {
                asv: asvResult,
                untis: untisResult,
                changed: [{ id: oldUserId, old: { userId: oldUserId }, new: { userId: newUserId } }]
            },
            warnings
        };
    }

    format(report) {
        if (!report) return '-';
        if (report.success === false) {
            return `<div style="color:var(--wa-color-danger-600)">Fehler: ${report.error || 'Unbekannter Fehler'}</div>`;
        }

        const suffix = report.devMode ? ' <span style="color:var(--wa-color-warning-600); font-size:0.9em;">(DevMode: Dry-Run)</span>' : '';
        const oldId = report.oldUserId || (report.params && report.params.oldUserId) || '?';
        const newId = report.newUserId || (report.params && report.params.newUserId) || '?';

        let html = `<div><strong>User-ID umbenannt:</strong> <code>${oldId}</code> &rarr; <code>${newId}</code>${suffix}</div>`;
        html += `<ul style="margin: 0.5rem 0 0 1rem; padding: 0; font-size: 0.9em;">`;
        html += `<li><span style="color:var(--wa-color-success-600)">✅ ASV:</span> Erfolgreich umbenannt</li>`;
        html += `<li><span style="color:var(--wa-color-success-600)">✅ Untis:</span> Erfolgreich umbenannt</li>`;
        html += `<li><span style="color:var(--wa-color-neutral-600)">ℹ️ WebUntis:</span> Nächste Stammdatenübertragung</li>`;
        html += `<li><span style="color:var(--wa-color-warning-600)">⚠️ Schulkonsole:</span> Manuelle Aktion nötig</li>`;
        html += `<li><span style="color:var(--wa-color-warning-600)">⚠️ Nextcloud:</span> Manuelle Aktion nötig</li>`;
        html += `<li><span style="color:var(--wa-color-warning-600)">⚠️ Matrix:</span> Manuelle Aktion nötig</li>`;
        html += `</ul>`;

        return html;
    }
}

module.exports = RenameUserIdTask;
