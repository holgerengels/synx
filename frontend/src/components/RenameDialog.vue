<template>
  <wa-dialog :open="open" @wa-after-hide="handleClose" label="Schüler:in umbenennen" style="--width: 700px; --body-spacing: 0;">
    <div style="padding: 1.25rem; display: flex; flex-direction: column; gap: 1.25rem;">

      <!-- Error / Success Alert -->
      <div v-if="submitError" style="padding: 0.75rem 1rem; border-radius: 6px; background: var(--wa-color-danger-50); border: 1px solid var(--wa-color-danger-300); color: var(--wa-color-danger-800); font-size: 0.9em; display: flex; align-items: center; gap: 0.5rem;">
        <wa-icon name="exclamation-triangle" style="font-size: 1.1rem; flex-shrink: 0;"></wa-icon>
        <div>{{ submitError }}</div>
      </div>

      <!-- Old User ID Section -->
      <div>
        <label style="display: block; font-weight: 500; font-size: 0.9em; margin-bottom: 0.35rem; color: var(--wa-color-neutral-800);">
          Alte User-ID (ASV)
        </label>
        <wa-input
          :value="oldUserId"
          @wa-input="onOldUserIdInput"
          @input="onOldUserIdInput"
          placeholder="z.B. mueller.max"
          clearable
          :disabled="isSubmitting"
        >
          <wa-icon slot="prefix" name="search"></wa-icon>
        </wa-input>

        <!-- Old User Search Feedback -->
        <div style="margin-top: 0.4rem; font-size: 0.85em; min-height: 1.4em;">
          <div v-if="oldUserStatus.loading" style="color: var(--wa-color-neutral-500); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="arrow-clockwise" class="spin"></wa-icon> Suche in ASV...
          </div>
          <div v-else-if="oldUserStatus.found && oldUserStatus.student" style="color: var(--wa-color-success-700); background: var(--wa-color-success-50); border: 1px solid var(--wa-color-success-200); padding: 0.4rem 0.6rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.4rem;">
            <wa-icon name="check-circle-fill" style="color: var(--wa-color-success-600);"></wa-icon>
            <strong>{{ oldUserStatus.student.firstName }} {{ oldUserStatus.student.lastName }}</strong>
            <span v-if="oldUserStatus.student.clazz">({{ oldUserStatus.student.clazz }})</span>
            <span v-if="oldUserStatus.student.birthday" style="color: var(--wa-color-neutral-500);">*{{ oldUserStatus.student.birthday }}</span>
          </div>
          <div v-else-if="oldUserId.trim() && !oldUserStatus.loading && !oldUserStatus.found" style="color: var(--wa-color-danger-600); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="x-circle-fill"></wa-icon> Keine Schüler:in mit dieser User-ID in ASV gefunden.
          </div>
        </div>
      </div>

      <!-- New User ID Section -->
      <div>
        <label style="display: block; font-weight: 500; font-size: 0.9em; margin-bottom: 0.35rem; color: var(--wa-color-neutral-800);">
          Neue User-ID
        </label>
        <wa-input
          :value="newUserId"
          @wa-input="onNewUserIdInput"
          @input="onNewUserIdInput"
          placeholder="z.B. meier.max"
          clearable
          :disabled="isSubmitting"
        >
          <wa-icon slot="prefix" name="person"></wa-icon>
        </wa-input>

        <!-- New User Availability Feedback -->
        <div style="margin-top: 0.4rem; font-size: 0.85em; min-height: 1.4em;">
          <div v-if="newUserStatus.loading" style="color: var(--wa-color-neutral-500); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="arrow-clockwise" class="spin"></wa-icon> Verfügbarkeit wird geprüft...
          </div>
          <div v-else-if="sameIdError" style="color: var(--wa-color-danger-600); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="exclamation-circle-fill"></wa-icon> Neue User-ID darf nicht identisch mit der alten sein.
          </div>
          <div v-else-if="formatError" style="color: var(--wa-color-danger-600); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="exclamation-circle-fill"></wa-icon> {{ formatError }}
          </div>
          <div v-else-if="newUserStatus.available === true" style="color: var(--wa-color-success-700); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="check-circle-fill" style="color: var(--wa-color-success-600);"></wa-icon> User-ID ist in ASV verfügbar
          </div>
          <div v-else-if="newUserStatus.available === false" style="color: var(--wa-color-danger-600); display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="x-circle-fill"></wa-icon> User-ID ist in ASV bereits vergeben!
          </div>
        </div>
      </div>

      <!-- Untis Readiness Check -->
      <div style="border: 1px solid var(--wa-color-neutral-200); border-radius: 8px; background: var(--wa-color-neutral-50); padding: 0.75rem 1rem; font-size: 0.85em;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <strong style="color: var(--wa-color-neutral-700);">Untis MultiUser DB:</strong>
            <template v-if="untisStatus.loading">
              <wa-icon name="arrow-clockwise" class="spin" style="color: var(--wa-color-neutral-500);"></wa-icon>
              <span style="color: var(--wa-color-neutral-600);">Clients werden geprüft...</span>
            </template>
            <template v-else-if="untisStatus.error">
              <wa-icon name="exclamation-triangle" style="color: var(--wa-color-warning-600);"></wa-icon>
              <span style="color: var(--wa-color-warning-700);">Status konnte nicht ermittelt werden: {{ untisStatus.error }}</span>
            </template>
            <template v-else-if="untisStatus.active">
              <wa-icon name="x-circle-fill" style="color: var(--wa-color-danger-600);"></wa-icon>
              <span style="color: var(--wa-color-danger-700); font-weight: 500;">
                {{ untisStatus.count }} Untis-Client(s) aktiv eingeloggt. Umbenennung blockiert.
              </span>
            </template>
            <template v-else>
              <wa-icon name="check-circle-fill" style="color: var(--wa-color-success-600);"></wa-icon>
              <span style="color: var(--wa-color-success-700);">Keine Untis-Clients eingeloggt (Bereit zur Umbenennung)</span>
            </template>
          </div>
          <wa-button variant="text" size="small" @click="fetchUntisStatus" :disabled="untisStatus.loading" style="padding: 0; min-height: auto;">
            <wa-icon name="arrow-clockwise" :class="{ spin: untisStatus.loading }"></wa-icon>
          </wa-button>
        </div>

        <!-- Active Untis Sessions List -->
        <div v-if="untisStatus.active && untisStatus.sessions && untisStatus.sessions.length" style="margin-top: 0.6rem; padding: 0.5rem 0.75rem; background: var(--wa-color-danger-50); border: 1px solid var(--wa-color-danger-200); border-radius: 6px;">
          <div style="font-weight: 600; color: var(--wa-color-danger-900); margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.35rem;">
            <wa-icon name="person-fill-lock" style="font-size: 1rem; color: var(--wa-color-danger-600);"></wa-icon>
            <span>Aktive Untis-Benutzer:</span>
          </div>
          <ul style="margin: 0; padding-left: 1.25rem; color: var(--wa-color-danger-800); line-height: 1.5;">
            <li v-for="(sess, i) in untisStatus.sessions" :key="i">
              <strong>{{ sess.user }}</strong>
              <span v-if="sess.osUser || sess.workstation" style="color: var(--wa-color-neutral-700);">
                ({{ [sess.osUser, sess.workstation].filter(Boolean).join(' an ') }})
              </span>
              <span v-if="sess.loginAt" style="color: var(--wa-color-neutral-600); margin-left: 0.25rem;">
                – angemeldet seit {{ sess.loginAt }}
              </span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Konsequenzen & bekannte Probleme Box -->
      <div style="border: 1px solid var(--wa-color-warning-300); border-radius: 8px; background: var(--wa-color-warning-50); padding: 0.85rem 1rem;">
        <div style="font-weight: 600; font-size: 0.9em; color: var(--wa-color-warning-900); margin-bottom: 0.65rem; display: flex; align-items: center; gap: 0.4rem;">
          <wa-icon name="exclamation-triangle-fill" style="color: var(--wa-color-warning-600); font-size: 1rem;"></wa-icon>
          <span>Konsequenzen &amp; bekannte Probleme bei einer Umbenennung:</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 0.65rem; font-size: 0.85em; color: var(--wa-color-neutral-800);">
          
          <!-- Schulkonsole -->
          <div style="display: flex; gap: 0.6rem; align-items: flex-start;">
            <div style="min-width: 105px; font-weight: 600; color: var(--wa-color-danger-700);">Schulkonsole:</div>
            <div style="line-height: 1.4;">
              User wird gelöscht und neu angelegt:
              <ul style="margin: 0.25rem 0 0 1rem; padding: 0; color: var(--wa-color-danger-800);">
                <li><strong>Neues Passwort erforderlich</strong>.</li>
                <li><strong>Dateien auf dem H-Laufwerk gehen verloren</strong> (vorher manuell sichern!).</li>
              </ul>
            </div>
          </div>

          <!-- Nextcloud -->
          <div style="display: flex; gap: 0.6rem; align-items: flex-start; border-top: 1px solid var(--wa-color-warning-200); padding-top: 0.5rem;">
            <div style="min-width: 105px; font-weight: 600; color: var(--wa-color-warning-800);">Nextcloud:</div>
            <div style="line-height: 1.4;">
              Sieht einen neuen User und den alten nicht mehr im LDAP:
              <ul style="margin: 0.25rem 0 0 1rem; padding: 0; color: var(--wa-color-neutral-700);">
                <li>Dateien können manuell vom alten in den neuen Benutzerordner kopiert werden.</li>
              </ul>
            </div>
          </div>

          <!-- Moodle -->
          <div style="display: flex; gap: 0.6rem; align-items: flex-start; border-top: 1px solid var(--wa-color-warning-200); padding-top: 0.5rem;">
            <div style="min-width: 105px; font-weight: 600; color: var(--wa-color-warning-800);">Moodle:</div>
            <div style="line-height: 1.4;">
              Sieht ebenfalls einen neuen User und den alten nicht mehr im LDAP:
              <ul style="margin: 0.25rem 0 0 1rem; padding: 0; color: var(--wa-color-neutral-700);">
                <li>Kurseinschreibungen, Abgaben und Bewertungen verbleiben am alten Moodle-Account.</li>
              </ul>
            </div>
          </div>

          <!-- WebUntis -->
          <div style="display: flex; gap: 0.6rem; align-items: flex-start; border-top: 1px solid var(--wa-color-warning-200); padding-top: 0.5rem;">
            <div style="min-width: 105px; font-weight: 600; color: var(--wa-color-primary-700);">WebUntis:</div>
            <div style="line-height: 1.4; color: var(--wa-color-neutral-700);">
              Wird bei der nächsten Stammdatenübertragung von Untis automatisch aktualisiert (Matching via <code>WEBUNTIS_ID</code>).
            </div>
          </div>

        </div>
      </div>

    </div>

    <!-- Dialog Footer -->
    <div slot="footer" style="display: flex; justify-content: flex-end; gap: 0.5rem;">
      <wa-button variant="neutral" @click="handleClose" :disabled="isSubmitting">
        Abbrechen
      </wa-button>
      <wa-button
        variant="primary"
        :disabled="!canSubmit"
        :loading="isSubmitting"
        @click="executeRename"
      >
        Umbenennen
      </wa-button>
    </div>
  </wa-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import axios from 'axios';
import { useToast } from '../composables/useToast';

const props = defineProps({
  open: Boolean
});

const emit = defineEmits(['update:open', 'renamed']);
const toast = useToast();

const oldUserId = ref('');
const newUserId = ref('');
const isSubmitting = ref(false);
const submitError = ref('');

const oldUserStatus = ref({
  loading: false,
  found: false,
  student: null
});

const newUserStatus = ref({
  loading: false,
  available: null
});

const untisStatus = ref({
  loading: false,
  active: false,
  count: 0,
  sessions: [],
  error: ''
});

let oldSearchTimeout = null;
let newSearchTimeout = null;

function resetState() {
  oldUserId.value = '';
  newUserId.value = '';
  isSubmitting.value = false;
  submitError.value = '';
  oldUserStatus.value = { loading: false, found: false, student: null };
  newUserStatus.value = { loading: false, available: null };
  clearTimeout(oldSearchTimeout);
  clearTimeout(newSearchTimeout);
}

function handleClose() {
  if (isSubmitting.value) return;
  emit('update:open', false);
}

// When dialog opens, reset and fetch untis status
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    resetState();
    fetchUntisStatus();
  }
});

async function fetchUntisStatus() {
  untisStatus.value.loading = true;
  untisStatus.value.error = '';
  try {
    const res = await axios.get('/api/untis/active-clients');
    untisStatus.value.active = !!res.data?.active;
    untisStatus.value.count = Number(res.data?.count) || 0;
    untisStatus.value.sessions = Array.isArray(res.data?.sessions) ? res.data.sessions : [];
  } catch (e) {
    untisStatus.value.error = e.response?.data?.error || e.message;
  } finally {
    untisStatus.value.loading = false;
  }
}

function onOldUserIdInput(event) {
  oldUserId.value = event.target.value;
  oldUserStatus.value = { loading: false, found: false, student: null };
  clearTimeout(oldSearchTimeout);

  const query = oldUserId.value.trim();
  if (!query) return;

  oldUserStatus.value.loading = true;
  oldSearchTimeout = setTimeout(async () => {
    try {
      const res = await axios.get(`/api/identities/asv?q=${encodeURIComponent(query)}`);
      const list = res.data?.data || [];
      const match = list.find(s => (s.userId || '').toLowerCase() === query.toLowerCase());

      if (match) {
        oldUserStatus.value = { loading: false, found: true, student: match };
      } else {
        oldUserStatus.value = { loading: false, found: false, student: null };
      }
    } catch (e) {
      oldUserStatus.value = { loading: false, found: false, student: null };
    }
  }, 300);
}

function onNewUserIdInput(event) {
  newUserId.value = event.target.value;
  newUserStatus.value = { loading: false, available: null };
  clearTimeout(newSearchTimeout);

  const query = newUserId.value.trim();
  if (!query || sameIdError.value || formatError.value) return;

  newUserStatus.value.loading = true;
  newSearchTimeout = setTimeout(async () => {
    try {
      const res = await axios.get(`/api/identities/asv?q=${encodeURIComponent(query)}`);
      const list = res.data?.data || [];
      const match = list.find(s => (s.userId || '').toLowerCase() === query.toLowerCase());

      if (match) {
        newUserStatus.value = { loading: false, available: false };
      } else {
        newUserStatus.value = { loading: false, available: true };
      }
    } catch (e) {
      newUserStatus.value = { loading: false, available: null };
    }
  }, 300);
}

const sameIdError = computed(() => {
  const oldVal = oldUserId.value.trim().toLowerCase();
  const newVal = newUserId.value.trim().toLowerCase();
  return oldVal && newVal && oldVal === newVal;
});

const formatError = computed(() => {
  const val = newUserId.value.trim();
  if (!val) return '';
  if (val.length < 2) return 'User-ID muss mindestens 2 Zeichen lang sein.';
  if (!/^[a-z0-9._-]+$/i.test(val)) return 'User-ID darf nur Buchstaben, Zahlen, Punkte, Bindestriche und Unterstriche enthalten.';
  return '';
});

const canSubmit = computed(() => {
  return (
    oldUserStatus.value.found &&
    newUserStatus.value.available === true &&
    !sameIdError.value &&
    !formatError.value &&
    !untisStatus.value.active &&
    !untisStatus.value.loading &&
    !isSubmitting.value
  );
});

async function executeRename() {
  if (!canSubmit.value) return;

  isSubmitting.value = true;
  submitError.value = '';

  const payload = {
    oldUserId: oldUserId.value.trim(),
    newUserId: newUserId.value.trim()
  };

  try {
    const res = await axios.post('/api/execute/rename-userid', payload);
    const msg = res.data?.html || `Schüler:in von ${payload.oldUserId} nach ${payload.newUserId} umbenannt.`;
    toast.show(msg, 'success');
    emit('renamed');
    emit('update:open', false);
  } catch (e) {
    submitError.value = e.response?.data?.error || e.message;
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<style scoped>
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
