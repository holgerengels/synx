#!/usr/bin/env node

const { registerDomain } = require('./domains/registry');
const { domains } = require('./domains/index');
const config = require('./config');
const tasks = require('./tasks/index');

// Initialize configured domains
if (config.domains) {
    config.domains.forEach(d => {
        if (domains[d.name]) {
            registerDomain(domains[d.name]);
        }
    });
}

const taskName = process.argv[2];

if (!taskName || taskName === '--help' || taskName === '-h') {
    console.log('Verwendung: ./run-task.sh <task-name> [JSON-Parameter]\n');
    console.log('Verfügbare Tasks:');
    Object.keys(tasks).sort().forEach(t => console.log(`  - ${t}`));
    process.exit(taskName ? 0 : 1);
}

const task = tasks[taskName];
if (!task) {
    console.error(`Fehler: Task '${taskName}' existiert nicht.\n`);
    console.log('Verfügbare Tasks:');
    Object.keys(tasks).sort().forEach(t => console.log(`  - ${t}`));
    process.exit(1);
}

let params = {};
if (process.argv[3]) {
    try {
        params = JSON.parse(process.argv[3]);
    } catch (e) {
        console.error('Fehler beim Parsen der JSON-Parameter:', e.message);
        process.exit(1);
    }
}

(async () => {
    try {
        const devMode = config.settings?.devMode ?? false;
        console.log(`[Synx] Führe Task aus: ${taskName} (DevMode: ${devMode})`);
        const startTime = Date.now();
        const result = await task.execute(params);
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Synx] Task erfolgreich abgeschlossen in ${durationSec}s:\n`);
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error(`\n[Synx] Fehler bei Ausführung von '${taskName}':`, err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
})();
