const express = require('express');
const router = express.Router();
const { getDomain, getAllDomains } = require('./domains/registry');
const DiffTask = require('./tasks/DiffTask');
const SyncTask = require('./tasks/SyncTask');
const config = require('./config');
const ManagableDomain = require('./domains/ManagableDomain');
const { login, refreshAccessToken, verifyToken } = require('./auth');

router.get('/health', (req, res) => res.json({ status: 'ok' }));

// ------------------------
// Auth APIs
// ------------------------

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

        const result = await login(username, password, true);
        if (!result) return res.status(401).json({ error: 'Invalid credentials' });

        if (!userHasAnyCategoryAccess(result.user)) {
            console.log(`[Auth Route] REJECTED: User ${username} has no access to any category.`);
            return res.status(403).json({ error: 'Zugriff verweigert: Ihr Account besitzt keine Berechtigungen.' });
        }

        res.json(result);
    } catch (e) {
        console.error('[Auth Route] Login Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.post('/refresh', (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'No refresh token' });

    const result = refreshAccessToken(refreshToken);
    if (!result) return res.status(401).json({ error: 'Refresh token invalid or expired' });

    if (!userHasAnyCategoryAccess(result.user)) {
        return res.status(403).json({ error: 'Zugriff verweigert: Ihr Account besitzt keine Berechtigungen.' });
    }

    res.json(result);
});

// ------------------------
// Dynamic Environment APIs
// ------------------------

// Check if a user matches any of the access rules for a category
function userHasAccess(user, accessRules) {
    if (!accessRules || !Array.isArray(accessRules) || accessRules.length === 0) return true;
    if (!user) return false;
    const userGroups = user.groups || [];
    return accessRules.some(rule => {
        if (rule.group) return userGroups.includes(rule.group);
        if (rule.user) return user.username === rule.user;
        return false;
    });
}

function userHasAnyCategoryAccess(user) {
    const allCategories = config.categories || [];
    if (allCategories.length === 0) return true;
    return allCategories.some(cat => userHasAccess(user, cat.access));
}

// Expose configuration for frontend dynamic rendering (filtered by user access)
router.get('/config/ui', verifyToken, (req, res) => {
    const { isDevMode } = require('./utils/devMode');
    const allCategories = config.categories || [];

    // Filter categories by user access
    const accessibleCategories = allCategories.filter(cat => userHasAccess(req.user, cat.access));
    if (allCategories.length > 0 && accessibleCategories.length === 0) {
        return res.status(403).json({ error: 'Zugriff verweigert: Ihr Account besitzt keine Berechtigungen.' });
    }

    const accessibleNames = new Set(accessibleCategories.map(c => c.name));

    res.json({
        categories: accessibleCategories.map(c => ({
            name: c.name,
            label: c.label,
            search: c.search,
            filter: c.filter
        })),
        domains: (config.domains || []).filter(d => accessibleNames.has(d.category)).map(d => {
            const domainInstance = getDomain(d.name);
            return {
                ...d,
                managable: domainInstance instanceof ManagableDomain
            };
        }),
        diffs: (config.diffs || []).filter(d => accessibleNames.has(d.category)),
        tasks: config.tasks || [],
        devMode: isDevMode()
    });
});

// Identities API for any registered domain
router.get('/identities/:domainName', verifyToken, async (req, res) => {
    try {
        const domain = getDomain(req.params.domainName);
        if (!domain) {
            return res.status(404).json({ error: `Domain ${req.params.domainName} not found or not registered` });
        }
        if (req.query.refresh === 'true') {
            domain.invalidate();
        }
        let identities = await domain.getIdentities();

        // 1. Get Category Config for search/filter fields
        const allCategories = config.categories || [];
        const domainConfig = (config.domains || []).find(d => d.name === req.params.domainName) || {};
        const categoryConfig = allCategories.find(c => c.name === domainConfig.category) || {};
        const searchFields = categoryConfig.search || ['userId', 'firstName', 'lastName'];
        const filterFields = categoryConfig.filter || [];

        // 2. Filter
        const q = (req.query.q || '').trim().toLowerCase();
        if (q) {
            if (q.startsWith('@') && filterFields.length) {
                const filterQuery = q.substring(1).trim();
                identities = identities.filter(ident =>
                    filterFields.some(field => {
                        const val = String(ident[field] || '').toLowerCase();
                        return val.includes(filterQuery);
                    })
                );
            } else {
                identities = identities.filter(ident =>
                    searchFields.some(field => {
                        const val = String(ident[field] || '').toLowerCase();
                        return val.includes(q);
                    })
                );
            }
        }

        // 3. Sort
        const sortKey = req.query.sort;
        if (sortKey) {
            const sortAsc = req.query.order !== 'desc';
            identities = [...identities].sort((a, b) => {
                let valA = a[sortKey] ?? '';
                let valB = b[sortKey] ?? '';
                if (typeof valA === 'string') valA = valA.toLowerCase();
                if (typeof valB === 'string') valB = valB.toLowerCase();
                if (valA < valB) return sortAsc ? -1 : 1;
                if (valA > valB) return sortAsc ? 1 : -1;
                return 0;
            });
        }

        const total = identities.length;

        // 4. Paginate
        if (req.query.limit) {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const startIndex = (page - 1) * limit;
            identities = identities.slice(startIndex, startIndex + limit);
        }

        res.json({
            data: identities,
            total,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || identities.length
        });
    } catch (e) {
        console.error(`[Route] GET /identities/${req.params.domainName} failed:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// CSV Export for any registered domain
router.get('/identities/:domainName/csv', verifyToken, async (req, res) => {
    try {
        const domain = getDomain(req.params.domainName);
        if (!domain) {
            return res.status(404).json({ error: `Domain ${req.params.domainName} not found or not registered` });
        }
        if (req.query.refresh === 'true') {
            domain.invalidate();
        }
        let identities = await domain.getIdentities();

        // Filter if query is provided
        const q = (req.query.q || '').trim().toLowerCase();
        if (q) {
            identities = identities.filter(ident =>
                Object.values(ident).some(val => String(val || '').toLowerCase().includes(q))
            );
        }

        const fileName = `${req.params.domainName}-identities.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        if (identities.length === 0) {
            return res.send('\uFEFF');
        }

        const ignoredKeys = new Set(['_id', '__v']);
        const headerSet = new Set();
        identities.forEach(ident => {
            Object.keys(ident).forEach(k => {
                if (!ignoredKeys.has(k)) headerSet.add(k);
            });
        });
        const headers = Array.from(headerSet);

        const formatCsvField = (val) => {
            if (val === null || val === undefined) return '';
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const csvRows = [];
        csvRows.push(headers.map(formatCsvField).join(','));

        for (const ident of identities) {
            const row = headers.map(h => formatCsvField(ident[h]));
            csvRows.push(row.join(','));
        }

        const csvContent = '\uFEFF' + csvRows.join('\n');
        res.send(csvContent);
    } catch (e) {
        console.error(`[Route] GET /identities/${req.params.domainName}/csv failed:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// Investigate: search for an identity ID across all domains in a category
router.get('/investigate/:category/:id', verifyToken, async (req, res) => {
    try {
        const { category, id } = req.params;

        // Find all domains belonging to this category
        const categoryDomains = (config.domains || []).filter(d => d.category === category);
        if (categoryDomains.length === 0) {
            return res.status(404).json({ error: `No domains found for category '${category}'` });
        }

        const results = [];

        for (const domainConfig of categoryDomains) {
            const domain = getDomain(domainConfig.name);
            if (!domain) {
                results.push({
                    domain: domainConfig.name,
                    titel: domainConfig.titel,
                    color: domainConfig.color,
                    found: false,
                    error: 'Domain not registered'
                });
                continue;
            }

            try {
                const identities = await domain.getIdentities();
                const match = identities.find(i => i.userId === id);
                results.push({
                    domain: domainConfig.name,
                    titel: domainConfig.titel,
                    color: domainConfig.color,
                    found: !!match,
                    identity: match || null
                });
            } catch (e) {
                results.push({
                    domain: domainConfig.name,
                    titel: domainConfig.titel,
                    color: domainConfig.color,
                    found: false,
                    error: e.message
                });
            }
        }

        res.json({ category, id, results });
    } catch (e) {
        console.error(`[Route] GET /investigate/${req.params.category}/${req.params.id} failed:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// Untis Active Clients Check
router.get('/untis/active-clients', verifyToken, async (req, res) => {
    try {
        const untis = getDomain('untis');
        if (!untis || typeof untis.hasActiveClients !== 'function') {
            return res.json({ active: false, count: 0 });
        }
        const status = await untis.hasActiveClients();
        res.json(status);
    } catch (e) {
        console.error('[Route] GET /untis/active-clients failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Generic Task Execution Endpoint — delegates to centralized taskRunner for consistent logging
router.post('/execute/:taskName', verifyToken, async (req, res) => {
    try {
        const { runTask } = require('./utils/taskRunner');
        const parameters = req.body || {};
        const report = await runTask(req.params.taskName, 'MANUAL', parameters);

        const tasks = require('./tasks/index');
        const task = tasks[req.params.taskName];
        let htmlSnippet = '';
        if (task) {
            htmlSnippet = typeof task.summarize === 'function' ? task.summarize(report) : task.format(report);
        }

        res.json({ status: 'success', report, html: htmlSnippet });
    } catch (e) {
        console.error(`[Route] POST /execute/${req.params.taskName} failed:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// Calculate Diff
router.post('/diff/:source/:target', verifyToken, async (req, res) => {
    try {
        const { source, target } = req.params;
        const registry = require('./tasks/index');
        const taskName = `${source}-${target}-diff`;
        const task = registry[taskName] || new DiffTask(source, target);
        const report = await task.execute({ forceRefresh: req.query.refresh === 'true' });

        // Read-only diff calculation — no logging needed
        res.json({
            status: 'success', summary: {
                added: report.details?.added?.length || 0,
                removed: report.details?.removed?.length || 0,
                changed: report.details?.changed?.length || 0,
                unchanged: report.details?.unchanged || 0
            }, report
        });
    } catch (e) {
        console.error(`[Route] POST /diff/${req.params.source}/${req.params.target} failed:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// Execute Sync — uses centralized logger for consistent log entries
router.post('/sync/:source/:target', verifyToken, async (req, res) => {
    try {
        const { source, target } = req.params;
        const registry = require('./tasks/index');
        const taskName = `${source}-${target}-sync`;
        const task = registry[taskName] || new SyncTask(source, target);
        const logger = require('./utils/logger');

        const logId = await logger.startTask(task.name, 'MANUAL');
        const report = await task.execute({ forceRefresh: req.query.refresh === 'true' });
        const htmlSnippet = task.format(report);

        const status = report.details?.errors?.length ? 'ERROR' : 'SUCCESS';
        await logger.endTask(logId, status, htmlSnippet, report.details || report);

        res.json({ status: 'success', details: report.details, devMode: report.devMode, html: htmlSnippet });
    } catch (e) {
        console.error(`[Route] POST /sync/${req.params.source}/${req.params.target} failed:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// Logs API
router.get('/logs', verifyToken, async (req, res) => {
    try {
        const Log = require('./models/Log');
        const limit = parseInt(req.query.limit) || 50;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;

        const total = await Log.countDocuments();
        const logs = await Log.find().sort({ startTime: -1 }).skip(skip).limit(limit);

        res.json({
            data: logs,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit)
        });
    } catch (e) {
        console.error('[Route] GET /logs failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

