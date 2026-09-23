const DiffTask = require('./DiffTask');
const SyncTask = require('./SyncTask');
const config = require('../config');

// All tasks registered as instances with kebab-case names
const registry = {
    'asv-generate-ids': require('../students/tasks/IdGenerationTask'),
    'dummy': new (require('../students/tasks/DummyTask'))(),
    'dummy-random-modifications': new (require('../students/tasks/DummyRandomModificationsTask'))(),
    'untis-generate-import': new (require('../students/tasks/UntisGenerateImportTask'))(),
    'untis-teacher-external-ids': require('../teachers/tasks/UntisTeacherExternalIdsTask'),
    'mailcow-teacher-initials': require('../teachers/tasks/MailcowTeacherInitialsTask'),
    'verwaltungsnetz-teacher-logins': require('../teachers/tasks/VerwaltungsnetzTeacherLoginsTask'),
    'web-untis-set-exit-dates': new (require('../students/tasks/WebUntisSetExitDatesTask'))(),
    'web-untis-guardian-sync': new (require('../students/tasks/WebUntisGuardianSyncTask'))(),
    'web-untis-majority': new (require('../students/tasks/WebUntisMajorityTask'))(),
    'nextcloud-remnants-list': new (require('../students/tasks/NextcloudRemnantsListTask'))(),
    'nextcloud-remnants-purge': new (require('../students/tasks/NextcloudRemnantsPurgeTask'))(),
    'fachnetz-profile-maintenance': new (require('../fachnetz/tasks/ProfileMaintenanceTask'))(),
    'fachnetz-arbeitsheft-diff': new (require('../fachnetz/tasks/FachnetzArbeitsheftDiffTask'))(),
    'fachnetz-arbeitsheft-sync': new (require('../fachnetz/tasks/FachnetzArbeitsheftSyncTask'))(),
    'matrix-moodle-courses': new (require('../students/tasks/MatrixMoodleCoursesTask'))(),
    'matrix-reconcile-users': new (require('../students/tasks/MatrixReconcileUsersTask'))(),
    'paedml-fix-password-expiration': new (require('../students/tasks/PaedmlFixPasswordExpirationTask'))(),
    'rename-userid': new (require('../students/tasks/RenameUserIdTask'))()
};

// Dynamically register SyncTask and DiffTask instances from config
if (config && config.tasks) {
    for (const t of config.tasks) {
        if (t.class === 'SyncTask' && t.source && t.target) {
            registry[t.name] = new SyncTask(t.source.toLowerCase(), t.target.toLowerCase());
            registry[t.name].name = t.name;
        }
        if (t.class === 'DiffTask' && t.source && t.target) {
            registry[t.name] = new DiffTask(t.source.toLowerCase(), t.target.toLowerCase());
            registry[t.name].name = t.name;
        }
    }
}

module.exports = registry;
