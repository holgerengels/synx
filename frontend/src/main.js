import { createApp } from 'vue';
import { createPinia } from 'pinia';
import axios from 'axios';
import App from './App.vue';
import { createRouter, createWebHistory } from 'vue-router';
import './axios';
import { useAuthStore } from './stores/auth';

// Initialize Web Awesome locally
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import { setBasePath } from '@awesome.me/webawesome/dist/utilities/base-path.js';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
setBasePath('/');

registerIconLibrary('default', {
    resolver: name => `/icons/${name}.svg`
});

// Import used components
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

import Dashboard from './views/Dashboard.vue';
import GenericDomainView from './views/GenericDomainView.vue';
import GenericDiffView from './views/GenericDiffView.vue';
import Login from './views/Login.vue';
import Logs from './views/Logs.vue';

// Pre-auth setup for axios to include credentials
axios.defaults.withCredentials = true;

async function bootstrap() {
    const app = createApp(App);
    const pinia = createPinia();
    app.use(pinia);

    // Fetch config for dynamic routing (only if we have a token)
    let remoteConfig = { categories: [], domains: [], diffs: [], tasks: [] };
    const storedToken = localStorage.getItem('token');
    if (storedToken) {
        try {
            const res = await axios.get('/api/config/ui', { skipAuthQueue: true });
            remoteConfig = res.data;
        } catch (e) {
            console.error("Failed to load config", e);
            const auth = useAuthStore();
            auth.logout();
        }
    }

    // Pass the config down to app via Provide/Inject
    app.provide('synxConfig', remoteConfig);

    const categories = remoteConfig.categories || [];
    const dynamicRoutes = [];

    // Per-category dashboard routes (cat.name is the URL slug)
    categories.forEach(cat => {
        dynamicRoutes.push({
            path: `/${cat.name}`,
            name: `dashboard-${cat.name}`,
            component: Dashboard,
            props: { config: remoteConfig, category: cat.name }
        });
    });
    
    // Domain detail routes
    remoteConfig.domains?.forEach(domain => {
        const category = categories.find(c => c.name === domain.category) || {};
        dynamicRoutes.push({
            path: `/domain/${domain.name}`,
            name: `domain-${domain.name}`,
            component: GenericDomainView,
            props: { domain, category }
        });
    });

    // Diff detail routes
    remoteConfig.diffs?.forEach(diff => {
        dynamicRoutes.push({
            path: `/diff/${diff.name}`,
            name: `diff-${diff.name}`,
            component: GenericDiffView,
            props: { diff }
        });
    });

    // Default route redirects to first category
    const defaultRedirect = categories.length > 0 ? `/${categories[0].name}` : '/logs';

    const routes = [
        { path: '/', redirect: defaultRedirect },
        { path: '/login', name: 'Login', component: Login },
        { path: '/logs', name: 'Logs', component: Logs },
        ...dynamicRoutes
    ];

    const router = createRouter({
        history: createWebHistory(),
        routes,
    });

    router.beforeEach((to, from, next) => {
        const auth = useAuthStore();
        if (to.path === '/login' && auth.isAuthenticated) {
            next('/');
        } else {
            next();
        }
    });

    // Relying on global Axios interceptors for 401 routing via Login Overlay

    app.use(router);
    app.mount('#app');

    // Show login overlay if not authenticated
    if (!storedToken) {
        const auth = useAuthStore();
        auth.triggerLogin();
    }
}

bootstrap();
