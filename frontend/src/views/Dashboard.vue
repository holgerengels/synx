<template>
  <div style="margin-top: -0.5rem;">
    
    <div class="card-grid">
      <!-- Domain Cards for this category -->
      <DomainCard 
         v-for="d in filteredDomains" :key="d.name"
         :domain="d" 
         :count="counts[d.name]" 
         :loading="loading[d.name]" 
         @run-action="runAction" 
         @download-csv="downloadDomainCsv"
         @refresh="refreshDomain" />
      
      <!-- Visual Diff Cards for this category -->
      <DiffCard 
         v-for="df in filteredDiffs" :key="df.name"
         :diff="df"
         :stats="diffStats[df.name]"
         :loading="loading[df.name]"
         @run-action="runAction"
         @refresh="refreshDiff"
         @sync="runSync" />
    </div>
    
    <!-- Generic Action Report Dialog -->
    <wa-dialog :label="reportDialogTitle" :open="isDialogOpen" @wa-after-hide="isDialogOpen = false" style="--width: 800px; --body-spacing: 0;">
      
      <!-- Standard HTML Reports -->
      <div v-if="reportDialogContent" v-html="reportDialogContent" style="padding: 1rem; font-size: 0.9em;"></div>

      <div slot="footer" style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <wa-button variant="neutral" @click="isDialogOpen = false">Schließen</wa-button>
      </div>
    </wa-dialog>

    <RemnantsDialog 
        :open="isRemnantsDialogOpen" 
        @update:open="val => isRemnantsDialogOpen = val" 
        :remnants="reportDialogRemnants"
    />

    <RenameDialog 
        :open="isRenameDialogOpen" 
        @update:open="val => isRenameDialogOpen = val" 
        @renamed="loadCategoryData()"
    />

  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import axios from 'axios';
import DomainCard from '../components/DomainCard.vue';
import DiffCard from '../components/DiffCard.vue';
import RemnantsDialog from '../components/RemnantsDialog.vue';
import RenameDialog from '../components/RenameDialog.vue';
import { useToast } from '../composables/useToast';
import { getDiffDomains } from '../utils/diffDomains.js';

const props = defineProps({
    config: Object,
    category: String
});

const loading = ref({});
const counts = ref({});
const diffStats = ref({});
const actionLoading = ref('');
const error = ref('');

const isDialogOpen = ref(false);
const isRemnantsDialogOpen = ref(false);
const isRenameDialogOpen = ref(false);
const reportDialogTitle = ref('');
const reportDialogContent = ref('');
const reportDialogRemnants = ref([]);

const toast = useToast();

const filteredDomains = computed(() => {
    return (props.config?.domains || []).filter(d => d.category === props.category);
});

const filteredDiffs = computed(() => {
    return (props.config?.diffs || []).filter(d => d.category === props.category);
});

function formatTitel(titelString) {
    if (titelString.includes('—>')) {
        return titelString.split('—>').map(s => s.trim());
    } else if (titelString.includes('->')) {
        return titelString.split('->').map(s => s.trim());
    } else if (titelString.includes('-')) {
        return titelString.split('-').map(s => s.trim());
    }
    return [titelString, '?'];
}

function findDiff(diffName) {
    return (props.config?.diffs || []).find(d => d.name === diffName);
}

async function refreshDiff(diffName, forceRefresh = false) {
    loading.value[diffName] = true;
    try {
        const df = findDiff(diffName);
        const { source, target } = df ? getDiffDomains(df) : { source: diffName.split('-')[0], target: diffName.split('-')[1] };
        const url = `/api/diff/${source}/${target}` + (forceRefresh ? '?refresh=true' : '');
        const res = await axios.post(url);
        if (res.data && res.data.summary) {
            diffStats.value[diffName] = res.data.summary;
        }
    } catch(e) {
        diffStats.value[diffName] = 'Error';
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`Diff Fehler: ${explanation}`);
    } finally {
        loading.value[diffName] = false;
    }
}

function loadCategoryData() {
    if (!props.config) return;
    filteredDomains.value.forEach(d => {
        axios.get(`/api/identities/${d.name}?limit=1`)
            .then(res => {
                counts.value[d.name] = res.data?.total || 0;
            })
            .catch(e => {
                counts.value[d.name] = 'Error';
                const explanation = e.response?.data?.error || e.message;
                toast.danger(`Fehler beim Laden von ${d.name}: ${explanation}`);
            });
    });
    filteredDiffs.value.forEach(df => {
        refreshDiff(df.name, false);
    });
}

onMounted(() => {
    loadCategoryData();
});

watch(() => props.category, () => {
    loadCategoryData();
});

async function refreshDomain(name) {
    loading.value[name] = true;
    try {
        const res = await axios.get(`/api/identities/${name}?refresh=true&limit=1`);
        counts.value[name] = res.data?.total || 0;
        
        if (props.config && props.config.diffs) {
            for (const df of props.config.diffs) {
                const { source, target } = getDiffDomains(df);
                if (source === name || target === name) {
                    refreshDiff(df.name, true);
                }
            }
        }
    } catch(e) {
        counts.value[name] = 'Error';
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`Refresh failed (${name}): ${explanation}`);
    } finally {
        loading.value[name] = false;
    }
}

async function runSync(df) {
    const diffName = df.name;
    loading.value[diffName] = true;
    try {
        let taskName = '';
        if (props.config && props.config.tasks) {
            const t = props.config.tasks.find(x => x.class === 'SyncTask' && x.source === df.source && x.target === df.target);
            if (t) taskName = t.name;
        }
        
        const { source: srcDomain, target: tgtDomain } = getDiffDomains(df);
        
        let res;
        if (taskName) {
            res = await axios.post(`/api/execute/${taskName}?refresh=true`);
        } else {
            res = await axios.post(`/api/sync/${srcDomain}/${tgtDomain}?refresh=true`);
        }
        
        const msgHtml = res.data?.html || `Sync finished`;
        toast.show(msgHtml, 'success');
        
        // Auto-invalidate and refresh the target domain count
        refreshDomain(tgtDomain);
        
        // Auto-invalidate and recalculate the diff card
        refreshDiff(diffName, true);
        
    } catch(e) {
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`Sync Failed: ${explanation}`);
    } finally {
        loading.value[diffName] = false;
    }
}

function openDialog(dialogName, data, act) {
    if (dialogName === 'remnants' && data?.report?.remnants) {
        reportDialogTitle.value = act?.name || 'Nextcloud Remnants';
        reportDialogRemnants.value = data.report.remnants;
        isRemnantsDialogOpen.value = true;
    } else if (dialogName === 'rename') {
        isRenameDialogOpen.value = true;
    }
}

async function runAction(act, contextName) {
    // Dialog without previous task execution (e.g. Rename)
    if (act.dialog && !act.run && !act.endpoint && !act.task) {
        openDialog(act.dialog, null, act);
        return;
    }

    const actionKey = act.download || act.endpoint || act.run || act.task;
    if (!actionKey) return;
    
    actionLoading.value = act.name;
    error.value = '';
    
    try {
        if (contextName) {
            loading.value[contextName] = true;
        }
        
        const reqTaskName = actionKey.startsWith('/') ? actionKey.split('/').pop() : actionKey;
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
        
        // Handle Dialog with task result (e.g. Remnants)
        if (act.dialog) {
            openDialog(act.dialog, res.data, act);
            return;
        }
        
        const msgHtml = res.data?.html || `Aktion ausgeführt`;
        
        if (contextName) {
            toast.show(msgHtml, 'success');
            
            // Auto reload contextual layout
            if (contextName.includes('-')) {
                // It's a diff view, just refresh diff
                refreshDiff(contextName, true);
            } else {
                refreshDomain(contextName);
                
                // Diff tables connected to this domain also likely changed!
                if(props.config && props.config.diffs) {
                    for(const df of props.config.diffs) {
                        const { source, target } = getDiffDomains(df);
                        if(source === contextName || target === contextName) {
                            refreshDiff(df.name, true);
                        }
                    }
                }
            }
        } else {
            if (reqTaskName !== 'nextcloud-remnants-list') {
                 toast.show(msgHtml, 'success');
            }
        }
    } catch(e) {
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`Failed to execute ${act.name}: ${explanation}`);
    } finally {
        if (contextName) loading.value[contextName] = false;
    }
}

async function downloadDomainCsv(domainName) {
    loading.value[domainName] = true;
    try {
        const res = await axios.get(`/api/identities/${domainName}/csv`, { responseType: 'blob' });
        const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const href = URL.createObjectURL(blob);
        link.href = href;
        link.setAttribute('download', `${domainName}-identities.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(href), 100);
        toast.show(`CSV für ${domainName} heruntergeladen`, 'success');
    } catch(e) {
        const explanation = e.response?.data?.error || e.message;
        toast.danger(`CSV Export fehlgeschlagen (${domainName}): ${explanation}`);
    } finally {
        loading.value[domainName] = false;
    }
}
</script>

<style scoped>
.card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 1rem;
}
</style>

