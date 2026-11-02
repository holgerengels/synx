const Task = require('../../tasks/Task');
const { getDomain } = require('../../domains/registry');
const { isDevMode, limitInDevMode } = require('../../utils/devMode');
const config = require('../../config');

const DEFAULT_CATEGORIES = '!!;o.L.;kein L.;LB;---';

function parsePlaceholders(value = DEFAULT_CATEGORIES) {
    const codes = new Set();
    for (const entry of String(value).split(';')) {
        for (const code of entry.split(', ')) {
            const trimmed = code.trim();
            if (trimmed) codes.add(trimmed);
        }
    }
    return codes;
}

function teacherCodes(entry) {
    return (entry.period?.teachers || []).map((t) => t.el?.nameShort ?? '');
}

function classify(entry, placeholders) {
    const codes = teacherCodes(entry);
    if (codes.length === 0) return 'eligible';
    const ph = codes.filter((c) => placeholders.has(c)).length;
    if (ph === codes.length) return 'eligible';
    return ph > 0 ? 'mixed' : 'real';
}

function categoryOf(entry) {
    const codes = teacherCodes(entry);
    return codes.length ? [...codes].sort().join(', ') : 'LEER';
}

function topicMissing(entry) {
    if (entry.topicId == null) return true;
    return typeof entry.topicShort === 'string' && entry.topicShort.trim() === '';
}

function absenceOpen(entry) {
    return !!entry.absCheckNeeded && !entry.absChecked;
}

function blockKey(entry) {
    const p = entry.period || {};
    const date = p.dtRange?.start ? p.dtRange.start.slice(0, 10) : '';
    const classId = p.classes?.[0]?.el?.id ?? '';
    const lsId = p.lsId;
    if (lsId) {
        return `${date}_${classId}_${lsId}`;
    }
    return `period_${p.id}`;
}

/**
 * Closes open class register periods where no real teacher is assigned:
 * - Lessons whose teacher is a placeholder ("o.L.", "kein L.", "---", "LB", "!!") or missing altogether.
 * - Writes topic text "---" if topic is missing.
 * - Marks absences as checked if needed.
 * 
 * In accordance with requirements:
 * - Works directly without timetable block calculations.
 * - Applies changes to blocks directly.
 * - Strictly adheres to DevMode limit (max 1 mutation block when devMode is active).
 */
class WebUntisClassregCleanupTask extends Task {
    constructor() {
        super('web-untis-classreg-cleanup');
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
        const categoriesStr = rolesConfig.classregCategories || DEFAULT_CATEGORIES;
        const topicText = rolesConfig.topicText || '---';
        const placeholders = parsePlaceholders(categoriesStr);

        console.log(`[WebUntisClassregCleanupTask] Resolving school year range...`);
        const range = await untis.readSchoolYearRange();
        console.log(`[WebUntisClassregCleanupTask] Date range: ${range.start} to ${range.end}`);

        console.log(`[WebUntisClassregCleanupTask] Fetching open periods...`);
        const open = await untis.readOpenPeriods(range);
        console.log(`[WebUntisClassregCleanupTask] Fetched ${open.length} open periods.`);

        const mixed = {};
        const eligible = [];
        for (const entry of open) {
            const kind = classify(entry, placeholders);
            if (kind === 'eligible') {
                eligible.push(entry);
            } else if (kind === 'mixed') {
                const c = categoryOf(entry);
                mixed[c] = (mixed[c] || 0) + 1;
            }
        }

        const mixedTotal = Object.values(mixed).reduce((a, b) => a + b, 0);
        console.log(`[WebUntisClassregCleanupTask] Classification: ${eligible.length} eligible periods, ${mixedTotal} mixed, ${open.length - eligible.length - mixedTotal} real.`);

        // Group eligible periods into blocks (by date, class, lesson)
        const blocksMap = new Map();
        for (const entry of eligible) {
            const key = blockKey(entry);
            if (!blocksMap.has(key)) {
                blocksMap.set(key, {
                    key,
                    category: categoryOf(entry),
                    date: entry.period?.dtRange?.start ? entry.period.dtRange.start.slice(0, 10) : '',
                    lessonId: entry.period?.lsId,
                    className: entry.period?.classes?.[0]?.el?.name || '',
                    periods: [],
                    periodIds: [],
                    needsTopic: false,
                    needsAbsence: false
                });
            }
            const block = blocksMap.get(key);
            block.periods.push(entry);
            block.periodIds.push(entry.period.id);
            if (topicMissing(entry)) block.needsTopic = true;
            if (absenceOpen(entry)) block.needsAbsence = true;
        }

        const blocks = Array.from(blocksMap.values());
        const actionable = blocks.filter(b => b.needsTopic || b.needsAbsence);
        console.log(`[WebUntisClassregCleanupTask] Found ${blocks.length} eligible blocks (${actionable.length} actionable).`);

        const { items: batch, limited } = limitInDevMode(actionable);
        if (limited) {
            console.log(`[WebUntisClassregCleanupTask] DevMode active: Limited from ${actionable.length} to ${batch.length} block.`);
        }

        const categories = {};
        const cat = (name) => (categories[name] ||= { blocks: 0, periods: 0, topicWritten: 0, absencesChecked: 0 });

        const errors = [];
        let done = 0;
        let closedPeriodsCount = 0;

        for (const block of batch) {
            const c = cat(block.category);
            const anchorId = block.periodIds[0];
            try {
                if (block.needsTopic) {
                    const writtenTopics = await untis.writeLessonTopic(anchorId, topicText);
                    const writtenCount = Array.isArray(writtenTopics) && writtenTopics.length > 0
                        ? writtenTopics.length
                        : block.periodIds.length;
                    c.topicWritten += writtenCount;
                }
                if (block.needsAbsence) {
                    const checkedIds = await untis.markAbsencesChecked(anchorId);
                    const checkedCount = Array.isArray(checkedIds) && checkedIds.length > 0
                        ? checkedIds.length
                        : block.periodIds.length;
                    c.absencesChecked += checkedCount;
                }
                c.blocks++;
                c.periods += block.periodIds.length;
                closedPeriodsCount += block.periodIds.length;
                done++;
            } catch (err) {
                console.error(`[WebUntisClassregCleanupTask] Error processing block ${block.key} (period ${anchorId}):`, err.message);
                errors.push({
                    block: block.periodIds,
                    category: block.category,
                    message: err.message
                });
            }
        }

        console.log(`[WebUntisClassregCleanupTask] Completed: ${done} blocks closed (${closedPeriodsCount} periods)${errors.length ? `, ${errors.length} errors` : ''}.`);

        return {
            success: errors.length === 0,
            devMode,
            details: {
                range,
                openTotal: open.length,
                eligiblePeriods: eligible.length,
                actionableBlocks: actionable.length,
                done,
                closedPeriodsCount,
                categories,
                mixed,
                mixedTotal,
                limited,
                errors
            }
        };
    }

    format(report) {
        if (!report) return '-';
        if (report.success === false && (!report.details || report.details.done === 0)) {
            return `<div style="color:var(--wa-color-danger-600)">Fehler: ${report.error || report.details?.errors?.[0]?.message || 'Unbekannter Fehler'}</div>`;
        }

        const d = report.details || {};
        const parts = [];

        if (d.done > 0) {
            parts.push(`<span style="color:var(--wa-color-success-600)">${d.done} Block/Blöcke (${d.closedPeriodsCount} Std.) geschlossen</span>`);
        } else if (d.actionableBlocks === 0) {
            parts.push('<span style="color:var(--wa-color-neutral-500)">Keine offenen Stunden ohne Lehrkraft</span>');
        } else {
            parts.push('<span style="color:var(--wa-color-neutral-500)">Keine Änderungen vorgenommen</span>');
        }

        if (d.mixedTotal > 0) {
            parts.push(`<span style="color:var(--wa-color-neutral-600); font-size:0.9em;">(${d.mixedTotal} Std. mit echter Lehrkraft übersprungen)</span>`);
        }

        if (d.errors && d.errors.length > 0) {
            parts.push(`<span style="color:var(--wa-color-danger-600); font-size:0.9em;">${d.errors.length} Fehler</span>`);
        }

        let msg = `<div>${parts.join(', ')}`;
        if (d.limited || report.devMode) {
            msg += ` <span style="color:var(--wa-color-warning-600); font-size:0.9em;">(DevMode${d.limited ? ' Limit: 1' : ''})</span>`;
        }
        msg += `</div>`;
        return msg;
    }
}

module.exports = WebUntisClassregCleanupTask;
module.exports.parsePlaceholders = parsePlaceholders;
module.exports.classify = classify;
module.exports.categoryOf = categoryOf;
module.exports.topicMissing = topicMissing;
module.exports.absenceOpen = absenceOpen;
module.exports.blockKey = blockKey;
