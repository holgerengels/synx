import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { nextTick } from 'vue';
import axios from 'axios';
import Logs from '../Logs.vue';

vi.mock('axios');

describe('Logs.vue View', () => {
    let router;

    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();

        router = createRouter({
            history: createMemoryHistory(),
            routes: [{ path: '/logs', component: Logs }]
        });

        axios.get.mockImplementation((url, config) => {
            if (url === '/api/logs/tasks') {
                return Promise.resolve({
                    data: ['matrix-create-classrooms', 'asv-untis-sync']
                });
            }
            if (url === '/api/logs') {
                return Promise.resolve({
                    data: {
                        data: [
                            {
                                _id: '1',
                                startTime: new Date().toISOString(),
                                task: 'matrix-create-classrooms',
                                trigger: 'CRON',
                                status: 'SUCCESS',
                                durationMs: 120,
                                summaryHtml: '<span>OK</span>',
                                details: {}
                            },
                            {
                                _id: '2',
                                startTime: new Date().toISOString(),
                                task: 'asv-untis-sync',
                                trigger: 'MANUAL',
                                status: 'ERROR',
                                durationMs: 450,
                                summaryHtml: '<span>Failed</span>',
                                details: {}
                            }
                        ],
                        total: 2,
                        page: 1,
                        limit: 50,
                        pages: 1
                    }
                });
            }
            return Promise.reject(new Error(`Unhandled URL: ${url}`));
        });
    });

    it('renders logs and fetches tasks on mount', async () => {
        router.push('/logs');
        await router.isReady();

        const wrapper = mount(Logs, {
            global: {
                plugins: [router],
                stubs: {
                    'wa-button': true,
                    'wa-icon': true,
                    'wa-badge': true,
                    'wa-tag': true,
                    'wa-spinner': true,
                    'wa-card': true,
                    'wa-drawer': true,
                    'wa-input': true
                }
            }
        });

        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(axios.get).toHaveBeenCalledWith('/api/logs/tasks');
        expect(axios.get).toHaveBeenCalledWith('/api/logs', expect.objectContaining({
            params: expect.objectContaining({ page: 1, limit: 50 })
        }));

        expect(wrapper.text()).toContain('matrix-create-classrooms');
        expect(wrapper.text()).toContain('asv-untis-sync');
    });

    it('applies trigger filter when select changes', async () => {
        router.push('/logs');
        await router.isReady();

        const wrapper = mount(Logs, {
            global: {
                plugins: [router],
                stubs: {
                    'wa-button': true,
                    'wa-icon': true,
                    'wa-badge': true,
                    'wa-tag': true,
                    'wa-spinner': true,
                    'wa-card': true,
                    'wa-drawer': true,
                    'wa-input': true
                }
            }
        });

        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 10));

        const triggerSelect = wrapper.find('#filter-trigger');
        await triggerSelect.setValue('CRON');

        expect(axios.get).toHaveBeenLastCalledWith('/api/logs', expect.objectContaining({
            params: expect.objectContaining({ trigger: 'CRON', page: 1 })
        }));
    });

    it('applies task filter when select changes', async () => {
        router.push('/logs');
        await router.isReady();

        const wrapper = mount(Logs, {
            global: {
                plugins: [router],
                stubs: {
                    'wa-button': true,
                    'wa-icon': true,
                    'wa-badge': true,
                    'wa-tag': true,
                    'wa-spinner': true,
                    'wa-card': true,
                    'wa-drawer': true,
                    'wa-input': true
                }
            }
        });

        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 10));

        const taskSelect = wrapper.find('#filter-task');
        await taskSelect.setValue('matrix-create-classrooms');

        expect(axios.get).toHaveBeenLastCalledWith('/api/logs', expect.objectContaining({
            params: expect.objectContaining({ task: 'matrix-create-classrooms', page: 1 })
        }));
    });

    it('allows clearing all filters', async () => {
        router.push('/logs?trigger=CRON&task=matrix-create-classrooms');
        await router.isReady();

        const wrapper = mount(Logs, {
            global: {
                plugins: [router],
                stubs: {
                    'wa-button': true,
                    'wa-icon': true,
                    'wa-badge': true,
                    'wa-tag': true,
                    'wa-spinner': true,
                    'wa-card': true,
                    'wa-drawer': true,
                    'wa-input': true
                }
            }
        });

        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 10));

        // Initial fetch with route query params
        expect(axios.get).toHaveBeenCalledWith('/api/logs', expect.objectContaining({
            params: expect.objectContaining({ trigger: 'CRON', task: 'matrix-create-classrooms' })
        }));

        // Reset
        const resetItem = wrapper.find('.filter-reset-item');
        expect(resetItem.exists()).toBe(true);
        const resetBtn = resetItem.find('wa-button-stub');
        await resetBtn.trigger('click');

        expect(axios.get).toHaveBeenLastCalledWith('/api/logs', expect.objectContaining({
            params: { page: 1, limit: 50 }
        }));
    });
});
