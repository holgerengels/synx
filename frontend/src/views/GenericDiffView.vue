<template>
  <div :style="`--source-color: ${getBrandColor(diff.source, config)}; --target-color: ${getBrandColor(diff.target, config)};`">
    <div class="view-header">
    <h2 style="border-bottom: 3px solid transparent; border-image: linear-gradient(to right, var(--source-color), var(--target-color)) 1; padding-bottom: 0.5rem; margin-bottom: 1rem;">
      <span style="color: var(--source-color);">{{ diff.source }}</span>
      <span style="color: var(--wa-color-neutral-500); margin: 0 0.5rem;">&rarr;</span>
      <span style="color: var(--target-color);">{{ diff.target }}</span>
    </h2>
    
    <div style="margin-bottom: 1rem; display: flex; gap: 0.5rem; justify-content: space-between; align-items: center;">
        <div style="flex-grow: 1;"></div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <template v-if="diff.actions && diff.actions.length">
                <template v-for="(act, index) in diff.actions" :key="act.name">
                    <wa-button :id="`action-btn-detail-${index}`" variant="neutral" size="small" @click="runAction(act)" :loading="actionLoading === act.name">
                        {{ act.name }}
                    </wa-button>
                    <wa-tooltip :for="`action-btn-detail-${index}`" v-if="getActionDescription(act)">
                        {{ getActionDescription(act) }}
                    </wa-tooltip>
                </template>
            </template>
            <template v-if="isTargetManagable()">
                <wa-button id="sync-btn-detail" @click="runSync" :loading="actionLoading === 'sync'" variant="primary" size="small">
                    <wa-icon slot="prefix" name="arrow-right-circle"></wa-icon>
                    Synchronisieren
                </wa-button>
                <wa-tooltip for="sync-btn-detail" v-if="getSyncDescription()">
                    {{ getSyncDescription() }}
                </wa-tooltip>
            </template>
            <wa-button @click="calculateDiff(true)" :loading="loading" variant="neutral" size="small">
                <wa-icon slot="prefix" name="arrow-clockwise"></wa-icon>
                Neu berechnen
            </wa-button>
        </div>
    </div>
    </div>

    <!-- Action Report Dialog -->
    <wa-dialog :label="dialogTitle" :open="isDialogOpen" @wa-after-hide="isDialogOpen = false" style="--width: 800px; --body-spacing: 0;">
      <div v-if="dialogContent" v-html="dialogContent" style="padding: 1rem; font-size: 0.9em;"></div>
    </wa-dialog>
    <div v-if="error" class="error">{{ error }}</div>
    
    <wa-card v-if="report && report.details" class="table-card">
        <div style="display: flex; gap: 1.5rem; padding: 1rem; border-bottom: 1px solid var(--wa-color-neutral-200); background: var(--wa-color-neutral-50);">
            <wa-checkbox :checked="showAdded" @change="showAdded = $event.target.checked">
                <wa-icon name="plus-circle-fill" style="color: var(--wa-color-success-600); margin-right: 0.25rem;"></wa-icon> Hinzugefügt ({{ report.details.added ? report.details.added.length : 0 }})
            </wa-checkbox>
            <wa-checkbox :checked="showChanged" @change="showChanged = $event.target.checked">
                <wa-icon name="pencil-fill" style="color: var(--wa-color-warning-600); margin-right: 0.25rem;"></wa-icon> Geändert ({{ report.details.changed ? report.details.changed.length : 0 }})
            </wa-checkbox>
            <wa-checkbox :checked="showRemoved" @change="showRemoved = $event.target.checked">
                <wa-icon name="dash-circle-fill" style="color: var(--wa-color-danger-600); margin-right: 0.25rem;"></wa-icon> Entfernt ({{ report.details.removed ? report.details.removed.length : 0 }})
            </wa-checkbox>
        </div>
        <div class="table-container">
            <table class="diff-table">
                <thead>
                    <tr>
                        <th style="width: 50px; text-align: center;"></th>
                        <th>ID</th>
                        <th>Vorname</th>
                        <th>Nachname</th>
                        <th v-for="prop in extraProps" :key="prop">{{ formatPropName(prop) }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(row, index) in paginatedDiffs" :key="index" :class="'diff-row diff-' + row.type">
                        <td class="diff-action" :title="row.type">
                            <wa-icon v-if="row.type === 'added'" name="plus-circle-fill" style="color: var(--wa-color-success-600)"></wa-icon>
                            <wa-icon v-else-if="row.type === 'changed'" name="pencil-fill" style="color: var(--wa-color-warning-600)"></wa-icon>
                            <wa-icon v-else-if="row.type === 'removed'" name="dash-circle-fill" style="color: var(--wa-color-danger-600)"></wa-icon>
                        </td>
                        <td>{{ row.type === 'changed' ? row.id : row.id }}</td>

                        <template v-if="row.type === 'changed'">
                            <td :class="{'is-modified': row.new.firstName !== row.old.firstName}">
                                <template v-if="row.new.firstName !== row.old.firstName">
                                    <div class="old-val">{{ row.old.firstName || '-' }}</div>
                                    <span class="diff-arrow"> → </span>
                                </template>
                                <div class="new-val">{{ row.new.firstName || '-' }}</div>
                            </td>
                            <td :class="{'is-modified': row.new.lastName !== row.old.lastName}">
                                <template v-if="row.new.lastName !== row.old.lastName">
                                    <div class="old-val">{{ row.old.lastName || '-' }}</div>
                                    <span class="diff-arrow"> → </span>
                                </template>
                                <div class="new-val">{{ row.new.lastName || '-' }}</div>
                            </td>
                            <td v-for="prop in extraProps" :key="prop" :class="{'is-modified': row.new[prop] !== row.old[prop]}">
                                <template v-if="row.new[prop] !== row.old[prop]">
                                    <div class="old-val">{{ row.old[prop] || '-' }}</div>
                                    <span class="diff-arrow"> → </span>
                                </template>
                                <div class="new-val">{{ row.new[prop] || '-' }}</div>
                            </td>
                        </template>
                        
                        <template v-else-if="row.type === 'added'">
                            <td>{{ row.new.firstName }}</td>
                            <td>{{ row.new.lastName }}</td>
                            <td v-for="prop in extraProps" :key="prop">{{ row.new[prop] }}</td>
                        </template>
                        
                        <template v-else-if="row.type === 'removed'">
                            <td>{{ row.old.firstName }}</td>
                            <td>{{ row.old.lastName }}</td>
                            <td v-for="prop in extraProps" :key="prop">{{ row.old[prop] }}</td>
                        </template>
                    </tr>
                    
                    <tr v-if="total === 0">
                        <td :colspan="4 + extraProps.length" style="text-align: center; padding: 2rem; color: var(--wa-color-neutral-500);">
                            Keine Änderungen gefunden.
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <div v-if="total > 0" class="pagination-controls" style="padding: 1rem; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--wa-color-neutral-200);">
            <div style="color: gray; font-size: 0.9em;">
                Zeige {{ (page - 1) * limit + 1 }} - {{ Math.min(page * limit, total) }} von {{ total }}
            </div>
            <div style="display: flex; gap: 0.5rem;">
                <wa-button size="small" variant="neutral" :disabled="page <= 1" @click="page--">
                    <wa-icon slot="prefix" name="chevron-left"></wa-icon> Zurück
                </wa-button>
                <wa-button size="small" variant="neutral" :disabled="page * limit >= total" @click="page++">
                    Weiter <wa-icon slot="suffix" name="chevron-right"></wa-icon>
                </wa-button>
            </div>
        </div>
    </wa-card>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, inject, computed } from 'vue';
import axios from 'axios';
import { getBrandColor } from '../utils/brandColors.js';
import { getDiffDomains } from '../utils/diffDomains.js';

const config = inject('synxConfig', { domains: [] });

const props = defineProps({
    diff: Object
});

import { useToast } from '../composables/useToast';

const toast = useToast();

const report = ref(null);
const loading = ref(false);
const actionLoading = ref('');
const error = ref('');
const dialogTitle = ref('');
const dialogContent = ref('');
const isDialogOpen = ref(false);

const page = ref(1);
const limit = ref(50);

const showAdded = ref(true);
const showChanged = ref(true);
const showRemoved = ref(true);

watch([showAdded, showChanged, showRemoved], () => {
    page.value = 1;
});

const allDiffs = computed(() => {
    if (!report.value || !report.value.details) return [];
    const diffs = [];
    if (showAdded.value && report.value.details.added) {
        diffs.push(...report.value.details.added.map(i => ({ type: 'added', new: i.new, id: i.id })));
    }
    if (showChanged.value && report.value.details.changed) {
        diffs.push(...report.value.details.changed.map(c => ({ type: 'changed', new: c.new, old: c.old, id: c.id })));
    }
    if (showRemoved.value && report.value.details.removed) {
        diffs.push(...report.value.details.removed.map(i => ({ type: 'removed', old: i.old, id: i.id })));
    }
    return diffs;
});

const paginatedDiffs = computed(() => {
    const startIndex = (page.value - 1) * limit.value;
    return allDiffs.value.slice(startIndex, startIndex + limit.value);
});

const total = computed(() => allDiffs.value.length);

const extraProps = computed(() => {
    if (!report.value || !report.value.intersectedProperties) return [];
    return report.value.intersectedProperties.filter(p => !['userId', 'firstName', 'lastName'].includes(p));
});

function formatPropName(prop) {
    const names = {
        'birthday': 'Geburtsdatum',
        'clazz': 'Klasse',
        'gender': 'Geschlecht',
        'email': 'E-Mail'
    };
    return names[prop] || prop;
}

onMounted(() => {
    calculateDiff(false);
});

watch(() => props.diff.name, () => {
    report.value = null;
    calculateDiff(false);
});

async function calculateDiff(refresh) {
    loading.value = true;
    error.value = '';
    page.value = 1;
    try {
        const { source, target } = getDiffDomains(props.diff);
        const res = await axios.post(`/api/diff/${source}/${target}${refresh ? '?refresh=true' : ''}`);
        report.value = res.data.report;
    } catch(e) {
        error.value = 'Failed to calculate diff';
    } finally {
        loading.value = false;
    }
}

async function runSync() {
    actionLoading.value = 'sync';
    error.value = '';
    try {
        const { source, target } = getDiffDomains(props.diff);
        const res = await axios.post(`/api/sync/${source}/${target}`);

        const msgHtml = res.data?.html || 'Synchronisierung erfolgreich';
        toast.show(msgHtml, 'success');
        
        await calculateDiff(true);
    } catch(e) {
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`Sync fehlgeschlagen: ${explanation}`);
    } finally {
        actionLoading.value = '';
    }
}

async function runAction(act) {
    const actionKey = act.download || act.endpoint || act.run || act.task;
    if (!actionKey) return;
    
    actionLoading.value = act.name;
    error.value = '';
    
    try {
        const res = await axios.post(actionKey.startsWith('/') ? actionKey : `/api/execute/${actionKey}`);

        // Handle Blob Downloads
        if (act.download && res.data && res.data.report && res.data.report.csvData) {
            const blob = new Blob([res.data.report.csvData], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.setAttribute('download', res.data.report.filename || 'export.csv');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }

        const msgHtml = res.data?.html || `Aktion ${act.name} ausgeführt`;
        toast.show(msgHtml, 'success');
        
        await calculateDiff(true);
    } catch(e) {
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`Aktion ${act.name} fehlgeschlagen: ${explanation}`);
    } finally {
        actionLoading.value = '';
    }
}

function getActionDescription(act) {
    const actionKey = act.download || act.endpoint || act.run || act.task;
    if (!actionKey) return '';
    const taskName = actionKey.startsWith('/') ? actionKey.split('/').pop() : actionKey;
    const task = (config?.tasks || []).find(t => t.name === taskName);
    return task?.description || '';
}

function getSyncDescription() {
    const task = (config?.tasks || []).find(x => x.class === 'SyncTask' && x.source === props.diff.source && x.target === props.diff.target);
    return task?.description || '';
}

function isTargetManagable() {
    const { target } = getDiffDomains(props.diff);
    const domain = (config?.domains || []).find(d => d.name === target);
    return domain ? domain.managable === true : false;
}
</script>

<style scoped>
.error {
    color: var(--wa-color-danger-600);
    margin-bottom: 1rem;
}

.table-card {
    width: 100%;
}
.table-container {
    width: 100%;
    overflow-x: auto;
    border-radius: 8px;
    border: 1px solid var(--wa-color-neutral-200);
}
.diff-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95rem;
    text-align: left;
}
.diff-table th {
    background-color: var(--wa-color-neutral-100);
    padding: 0.75rem 1rem;
    font-weight: 600;
    color: var(--wa-color-neutral-700);
    border-bottom: 2px solid var(--wa-color-neutral-200);
    white-space: nowrap;
}
.diff-table td {
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--wa-color-neutral-100);
    vertical-align: middle;
}
.diff-table tbody tr:hover {
    background-color: var(--wa-color-neutral-90);
}
.diff-action {
    text-align: center;
    font-size: 1.1rem;
}
.diff-added td {
    background-color: rgba(16, 185, 129, 0.05); /* success ultra-light */
}
.diff-removed td {
    background-color: rgba(239, 68, 68, 0.05); /* danger ultra-light */
    text-decoration: line-through;
    color: var(--wa-color-neutral-500);
}
.diff-removed .diff-action {
    text-decoration: none;
}
.is-modified {
    background-color: rgba(245, 158, 11, 0.1); /* warning ultra-light */
    border-radius: 4px;
}
.old-val {
    text-decoration: line-through;
    color: var(--wa-color-neutral-500);
    margin-bottom: 0.15rem;
}
.new-val {
    color: var(--wa-color-neutral-900);
    font-weight: 500;
}
.old-val, .new-val {
    display: inline-block;
}
.diff-arrow {
    color: var(--wa-color-neutral-500);
}
.view-header {
    position: sticky;
    top: 0;
    background-color: color-mix(in srgb, var(--wa-color-neutral-95) 80%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    z-index: 5;
    padding-bottom: 0.25rem;
}
</style>
