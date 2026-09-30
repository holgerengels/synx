<template>
  <div class="logs">
    <div class="logs-header">
      <div class="title-section">
        <h2>Logs</h2>
        <wa-badge v-if="hasActiveFilters" variant="primary" size="small">
          {{ totalLogs }} {{ totalLogs === 1 ? 'Eintrag' : 'Einträge' }} gefiltert
        </wa-badge>
        <span v-else-if="!loading" class="total-count-label">
          ({{ totalLogs }} {{ totalLogs === 1 ? 'Eintrag' : 'Einträge' }})
        </span>
      </div>

      <div class="header-actions">
        <wa-button variant="neutral" @click="fetchLogs(currentPage)" :disabled="loading" size="small">
          <wa-icon name="arrow-clockwise" slot="prefix"></wa-icon> Aktualisieren
        </wa-button>
      </div>
    </div>

    <!-- Filter Bar -->
    <div class="filters-card">
      <div class="filters-grid">
        <div class="filter-item">
          <label class="filter-label" for="filter-task">Task</label>
          <select id="filter-task" v-model="selectedTask" @change="onFilterChange" class="filter-select">
            <option value="">Alle Tasks ({{ availableTasks.length }})</option>
            <option v-for="t in availableTasks" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>

        <div class="filter-item">
          <label class="filter-label" for="filter-trigger">Auslöser</label>
          <select id="filter-trigger" v-model="selectedTrigger" @change="onFilterChange" class="filter-select">
            <option value="">Alle Auslöser</option>
            <option value="CRON">Zeitplan (CRON)</option>
            <option value="MANUAL">Manuell (MANUAL)</option>
          </select>
        </div>

        <div class="filter-item">
          <label class="filter-label" for="filter-status">Status</label>
          <select id="filter-status" v-model="selectedStatus" @change="onFilterChange" class="filter-select">
            <option value="">Alle Status</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="ERROR">ERROR</option>
            <option value="IN_PROGRESS">IN_PROGRESS</option>
          </select>
        </div>

        <div class="filter-item filter-search-item">
          <label class="filter-label" for="filter-search">Suche</label>
          <wa-input
            id="filter-search"
            :value="searchQuery"
            @wa-input="onSearchInput"
            @input="onSearchInput"
            placeholder="In Task oder Zusammenfassung suchen …"
            clearable
            size="small"
          >
            <wa-icon name="search" slot="prefix"></wa-icon>
          </wa-input>
        </div>

        <div class="filter-item filter-reset-item" v-if="hasActiveFilters">
          <label class="filter-label">&nbsp;</label>
          <wa-button variant="neutral" size="small" @click="resetFilters" title="Alle Filter entfernen">
            <wa-icon name="x-lg" slot="prefix"></wa-icon> Zurücksetzen
          </wa-button>
        </div>
      </div>

      <!-- Active Filter Tags -->
      <div v-if="hasActiveFilters" class="active-chips">
        <span class="active-chips-title">Aktive Filter:</span>
        <wa-tag v-if="selectedTask" size="small" removable @wa-remove="clearFilter('task')">
          Task: <strong>{{ selectedTask }}</strong>
        </wa-tag>
        <wa-tag v-if="selectedTrigger" size="small" variant="primary" removable @wa-remove="clearFilter('trigger')">
          Auslöser: <strong>{{ selectedTrigger }}</strong>
        </wa-tag>
        <wa-tag 
          v-if="selectedStatus" 
          size="small" 
          :variant="selectedStatus === 'SUCCESS' ? 'success' : selectedStatus === 'ERROR' ? 'danger' : 'warning'" 
          removable 
          @wa-remove="clearFilter('status')"
        >
          Status: <strong>{{ selectedStatus }}</strong>
        </wa-tag>
        <wa-tag v-if="searchQuery" size="small" removable @wa-remove="clearFilter('search')">
          Suche: <strong>"{{ searchQuery }}"</strong>
        </wa-tag>
        <wa-button variant="text" size="small" @click="resetFilters" style="padding: 0 0.25rem;">
          Alle löschen
        </wa-button>
      </div>
    </div>
    
    <div v-if="loading" style="display: flex; justify-content: center; padding: 3rem;">
      <wa-spinner style="font-size: 2rem;"></wa-spinner>
    </div>
    
    <div v-else>
      <wa-card style="width: 100%; margin-top: 1rem; overflow-x: auto;">
        <table class="log-table">
          <thead>
            <tr>
              <th>Startzeit</th>
              <th>Task</th>
              <th>Auslöser</th>
              <th>Status</th>
              <th>Dauer (ms)</th>
              <th>Zusammenfassung</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log._id">
              <td>{{ new Date(log.startTime).toLocaleString() }}</td>
              <td>
                <wa-tag 
                  size="small" 
                  class="clickable-tag" 
                  @click="setFilter('task', log.task)"
                  :title="`Nach Task '${log.task}' filtern`"
                >
                  {{ log.task }}
                </wa-tag>
              </td>
              <td>
                <wa-tag 
                  size="small" 
                  :variant="log.trigger === 'CRON' ? 'primary' : 'neutral'"
                  class="clickable-tag"
                  @click="setFilter('trigger', log.trigger)"
                  :title="`Nach Auslöser '${log.trigger}' filtern`"
                >
                  <wa-icon v-if="log.trigger === 'CRON'" name="clock" slot="prefix" style="margin-right: 3px;"></wa-icon>
                  {{ log.trigger }}
                </wa-tag>
              </td>
              <td>
                <wa-tag 
                  size="small" 
                  :variant="log.status === 'SUCCESS' ? 'success' : log.status === 'ERROR' ? 'danger' : 'warning'"
                  class="clickable-tag"
                  @click="setFilter('status', log.status)"
                  :title="`Nach Status '${log.status}' filtern`"
                >
                  {{ log.status }}
                </wa-tag>
              </td>
              <td>{{ log.durationMs !== undefined && log.durationMs !== null ? log.durationMs : '-' }}</td>
              <td>
                <span class="diff-summary" v-html="log.summaryHtml || '-'"></span>
              </td>
              <td>
                <wa-button 
                   variant="text" 
                   size="small" 
                   @click.stop.prevent="showDetails(log)"
                   :title="log.details ? 'Details / Diffs ansehen' : 'Keine Details vorhanden'">
                  <wa-icon name="list" style="font-size: 1.1rem;"></wa-icon>
                </wa-button>
              </td>
            </tr>
            <tr v-if="logs.length === 0">
              <td colspan="7" class="empty-state">
                <div style="font-size: 1.05rem; margin-bottom: 0.5rem; color: var(--wa-color-neutral-700);">
                  Keine Logs gefunden.
                </div>
                <div v-if="hasActiveFilters" style="color: var(--wa-color-neutral-500); margin-bottom: 1rem; font-size: 0.9rem;">
                  Keine Einträge entsprechen den ausgewählten Filtern.
                </div>
                <wa-button v-if="hasActiveFilters" variant="neutral" size="small" @click="resetFilters">
                  Filter zurücksetzen
                </wa-button>
              </td>
            </tr>
          </tbody>
        </table>
      </wa-card>
      
      <div v-if="totalPages > 1" style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem;">
        <wa-button variant="neutral" size="small" :disabled="currentPage <= 1 || loading" @click="changePage(currentPage - 1)">
          <wa-icon name="chevron-left" slot="prefix"></wa-icon> Zurück
        </wa-button>
        <span style="font-size: 0.9em; color: var(--wa-color-neutral-600);">
          Seite {{ currentPage }} von {{ totalPages }} ({{ totalLogs }} {{ totalLogs === 1 ? 'Eintrag' : 'Einträge' }})
        </span>
        <wa-button variant="neutral" size="small" :disabled="currentPage >= totalPages || loading" @click="changePage(currentPage + 1)">
          Weiter <wa-icon name="chevron-right" slot="suffix"></wa-icon>
        </wa-button>
      </div>
    </div>

    <wa-drawer :open="isDrawerOpen" @wa-after-hide="isDrawerOpen = false" label="Log Details & Diffs" style="--size: 80vw;">
      <div v-if="selectedLog">
        <div style="margin-bottom: 1rem; display: flex; gap: 1rem; flex-wrap: wrap;">
           <strong>ID:</strong> {{ selectedLog._id }}
           <strong>Task:</strong> {{ selectedLog.task }}
           <strong>Auslöser:</strong> {{ selectedLog.trigger }}
           <strong>Beginn:</strong> {{ new Date(selectedLog.startTime).toLocaleString() }}
           <strong>Status:</strong> {{ selectedLog.status }}
        </div>
        
        <div v-if="!selectedLog.details || Object.keys(selectedLog.details).length === 0">
           <p style="color: #666;">Für diesen Eintrag liegen keine tiefergehenden Daten oder Diffs vor (möglicherweise älter als 14 Tage und bereits bereinigt).</p>
        </div>
        <div v-else>
           <pre class="json-viewer">{{ JSON.stringify(selectedLog.details, null, 2) }}</pre>
        </div>
      </div>
    </wa-drawer>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';

const route = useRoute();
const router = useRouter();

const logs = ref([]);
const loading = ref(false);
const availableTasks = ref([]);

const selectedTask = ref(typeof route.query.task === 'string' ? route.query.task : '');
const selectedTrigger = ref(typeof route.query.trigger === 'string' ? route.query.trigger : '');
const selectedStatus = ref(typeof route.query.status === 'string' ? route.query.status : '');
const searchQuery = ref(typeof route.query.search === 'string' ? route.query.search : '');

const currentPage = ref(parseInt(route.query.page) || 1);
const totalPages = ref(1);
const totalLogs = ref(0);
const limit = 50;

const isDrawerOpen = ref(false);
const selectedLog = ref(null);

let searchTimer = null;

const hasActiveFilters = computed(() => {
  return Boolean(selectedTask.value || selectedTrigger.value || selectedStatus.value || searchQuery.value);
});

const updateUrlParams = (page = currentPage.value) => {
  const query = {};
  if (selectedTask.value) query.task = selectedTask.value;
  if (selectedTrigger.value) query.trigger = selectedTrigger.value;
  if (selectedStatus.value) query.status = selectedStatus.value;
  if (searchQuery.value) query.search = searchQuery.value;
  if (page > 1) query.page = String(page);

  router.replace({ query });
};

const fetchTasks = async () => {
  try {
    const res = await axios.get('/api/logs/tasks');
    availableTasks.value = res.data;
  } catch (e) {
    console.error('Fehler beim Laden der Tasks:', e);
  }
};

const fetchLogs = async (page = 1) => {
  loading.value = true;
  currentPage.value = page;
  updateUrlParams(page);
  try {
    const params = { page, limit };
    if (selectedTask.value) params.task = selectedTask.value;
    if (selectedTrigger.value) params.trigger = selectedTrigger.value;
    if (selectedStatus.value) params.status = selectedStatus.value;
    if (searchQuery.value) params.search = searchQuery.value;

    const res = await axios.get('/api/logs', { params });
    logs.value = res.data.data;
    currentPage.value = res.data.page;
    totalPages.value = res.data.pages;
    totalLogs.value = res.data.total;
  } catch (e) {
    console.error('Fehler beim Laden der Logs:', e);
  } finally {
    loading.value = false;
  }
};

const onFilterChange = () => {
  fetchLogs(1);
};

const onSearchInput = (e) => {
  searchQuery.value = e.target.value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    fetchLogs(1);
  }, 300);
};

const setFilter = (type, val) => {
  if (type === 'task') selectedTask.value = val;
  else if (type === 'trigger') selectedTrigger.value = val;
  else if (type === 'status') selectedStatus.value = val;
  fetchLogs(1);
};

const clearFilter = (type) => {
  if (type === 'task') selectedTask.value = '';
  else if (type === 'trigger') selectedTrigger.value = '';
  else if (type === 'status') selectedStatus.value = '';
  else if (type === 'search') searchQuery.value = '';
  fetchLogs(1);
};

const resetFilters = () => {
  selectedTask.value = '';
  selectedTrigger.value = '';
  selectedStatus.value = '';
  searchQuery.value = '';
  fetchLogs(1);
};

const changePage = (newPage) => {
  if (newPage >= 1 && newPage <= totalPages.value) {
    fetchLogs(newPage);
  }
};

const showDetails = (log) => {
  selectedLog.value = log;
  isDrawerOpen.value = true;
};

onMounted(() => {
  fetchTasks();
  fetchLogs(currentPage.value);
});
</script>

<style scoped>
.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.title-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.title-section h2 {
  margin: 0;
}

.total-count-label {
  font-size: 0.95rem;
  color: var(--wa-color-neutral-500, #64748b);
}

.filters-card {
  background: var(--wa-color-neutral-50, #f8fafc);
  border: 1px solid var(--wa-color-neutral-200, #e2e8f0);
  border-radius: var(--wa-border-radius-medium, 8px);
  padding: 1rem;
  margin-top: 1rem;
  margin-bottom: 1rem;
}

.filters-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 170px;
}

.filter-search-item {
  flex-grow: 1;
  min-width: 220px;
}

.filter-reset-item {
  min-width: auto;
}

.filter-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--wa-color-neutral-700, #475569);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.filter-select {
  height: 36px;
  padding: 0 0.75rem;
  font-size: 0.875rem;
  border-radius: var(--wa-border-radius-medium, 6px);
  border: 1px solid var(--wa-color-neutral-300, #cbd5e1);
  background-color: var(--wa-color-neutral-0, #fff);
  color: var(--wa-color-neutral-900, #0f172a);
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
}

.filter-select:focus {
  border-color: var(--wa-color-brand-500, #0284c7);
  box-shadow: 0 0 0 2px rgba(2, 132, 199, 0.2);
}

.active-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.85rem;
  padding-top: 0.75rem;
  border-top: 1px dashed var(--wa-color-neutral-200, #e2e8f0);
}

.active-chips-title {
  font-size: 0.8rem;
  color: var(--wa-color-neutral-600, #64748b);
  font-weight: 500;
}

.clickable-tag {
  cursor: pointer;
  transition: transform 0.12s ease, opacity 0.12s ease;
}

.clickable-tag:hover {
  transform: translateY(-1px);
  opacity: 0.85;
}

.log-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}

.log-table th, .log-table td {
  padding: 0.75rem;
  border-bottom: 1px solid #eee;
}

.log-table th {
  background: #fafafa;
  font-weight: 600;
}

.log-table tr:hover {
  background: #f9f9f9;
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem !important;
}

.diff-summary {
  display: inline-flex;
  gap: 0.5rem;
  font-weight: bold;
}

.diff-add { color: #10B981; }
.diff-change { color: #F59E0B; }
.diff-remove { color: #EF4444; }

.json-viewer {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 1rem;
  border-radius: 4px;
  overflow-x: auto;
  max-height: 50vh;
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9rem;
}

/* Fix width handling for WA card */
wa-card::part(base) {
  padding: 0;
}
wa-card::part(body) {
  padding: 0;
}
</style>
