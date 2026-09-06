import { describe, it, expect, vi, beforeEach } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/version-sync.js';

describe('version-sync', () => {
    beforeEach(() => {
        vi.resetModules();
        delete window.PdfPreviewModalVersionSync;
    });

    async function loadModule() {
        await import(new URL(MODULE_PATH, import.meta.url));
        return window.PdfPreviewModalVersionSync;
    }

    it('exports createVersionSync', async () => {
        const mod = await loadModule();
        expect(typeof mod.createVersionSync).toBe('function');
    });

    it('does not emit onExternalChange when version matches', async () => {
        const mod = await loadModule();
        const { createVersionSync } = mod;
        const adapter = { getAnnotationsVersion: vi.fn().mockResolvedValue({ success: true, version: 'v1' }) };
        const sync = createVersionSync({}, { modeAdapter: adapter, submissionId: 1, assignmentId: 1 });
        const cb = vi.fn();
        sync.onExternalChange(cb);
        await sync._checkVersion(); // first call sets version
        await sync._checkVersion(); // same version
        expect(cb).not.toHaveBeenCalled();
        sync.destroy();
    });

    it('emits onExternalChange when version changes', async () => {
        const mod = await loadModule();
        const { createVersionSync } = mod;
        const adapter = {
            getAnnotationsVersion: vi.fn()
                .mockResolvedValueOnce({ success: true, version: 'v1' })
                .mockResolvedValueOnce({ success: true, version: 'v2' })
        };
        const sync = createVersionSync({}, { modeAdapter: adapter, submissionId: 1, assignmentId: 1 });
        const cb = vi.fn();
        sync.onExternalChange(cb);
        await sync._checkVersion(); // sets v1
        await sync._checkVersion(); // detects change to v2
        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith({ previousVersion: 'v1', newVersion: 'v2' });
        sync.destroy();
    });

    it('defers an external-change reload signal until drawing persistence is idle', async () => {
        vi.useFakeTimers();
        let drawingUnsafe = true;
        const mod = await loadModule();
        const adapter = {
            getAnnotationsVersion: vi.fn()
                .mockResolvedValueOnce({ success: true, version: 'v1' })
                .mockResolvedValueOnce({ success: true, version: 'v2' })
        };
        const sync = mod.createVersionSync({}, {
            modeAdapter: adapter,
            submissionId: 1,
            assignmentId: 1,
            isDrawingFn: () => drawingUnsafe,
        });
        const cb = vi.fn();
        sync.onExternalChange(cb);

        await sync._checkVersion();
        await sync._checkVersion();

        expect(cb, 'external annotation reload was emitted while ink was unsafe').not.toHaveBeenCalled();

        drawingUnsafe = false;
        await vi.advanceTimersByTimeAsync(50);
        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith({ previousVersion: 'v1', newVersion: 'v2' });

        sync.destroy();
        vi.useRealTimers();
    });

    it('emits an external change eventually even if ink never becomes safe', async () => {
        // Unbounded, a stroke that never settles means an external annotation
        // change is never surfaced and the viewer silently shows stale data for
        // the rest of the session.
        vi.useFakeTimers();
        const mod = await loadModule();
        const adapter = {
            getAnnotationsVersion: vi.fn()
                .mockResolvedValueOnce({ success: true, version: 'v1' })
                .mockResolvedValueOnce({ success: true, version: 'v2' })
        };
        const sync = mod.createVersionSync({}, {
            modeAdapter: adapter,
            submissionId: 1,
            assignmentId: 1,
            isDrawingFn: () => true,          // never becomes safe
        });
        const cb = vi.fn();
        sync.onExternalChange(cb);

        await sync._checkVersion();
        await sync._checkVersion();

        await vi.advanceTimersByTimeAsync(2000);
        expect(cb, 'gave up so fast it is not a guard').not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(12000);
        expect(cb, 'the external change is never surfaced: stale forever')
            .toHaveBeenCalledOnce();

        sync.destroy();
        vi.useRealTimers();
    });

    it('skips one cycle after markLocalChange()', async () => {
        const mod = await loadModule();
        const { createVersionSync } = mod;
        const adapter = {
            getAnnotationsVersion: vi.fn()
                .mockResolvedValueOnce({ success: true, version: 'v1' })
                .mockResolvedValueOnce({ success: true, version: 'v2' })
        };
        const sync = createVersionSync({}, { modeAdapter: adapter, submissionId: 1, assignmentId: 1 });
        const cb = vi.fn();
        sync.onExternalChange(cb);
        await sync._checkVersion(); // sets v1
        sync.markLocalChange();
        await sync._checkVersion(); // should skip
        expect(cb).not.toHaveBeenCalled();
        sync.destroy();
    });

    it('accepts a plain string version response for backward compatibility', async () => {
        const mod = await loadModule();
        const { createVersionSync } = mod;
        const adapter = { getAnnotationsVersion: vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2') };
        const syncState = {};
        const sync = createVersionSync(syncState, { modeAdapter: adapter, submissionId: 1, assignmentId: 1 });
        const cb = vi.fn();
        sync.onExternalChange(cb);

        await sync._checkVersion();
        await sync._checkVersion();

        expect(cb).toHaveBeenCalledWith({ previousVersion: 'v1', newVersion: 'v2' });
        expect(syncState.versionToken).toBe('v2');
        sync.destroy();
    });

    it('stop() clears the polling timer', async () => {
        const mod = await loadModule();
        const { createVersionSync } = mod;
        const sync = createVersionSync({}, { modeAdapter: null, submissionId: 1, assignmentId: 1 });
        sync.start();
        sync.stop();
        // No error means timer was properly cleared
        sync.destroy();
    });

    it('destroy() is idempotent', async () => {
        const mod = await loadModule();
        const { createVersionSync } = mod;
        const sync = createVersionSync({}, { modeAdapter: null, submissionId: 1, assignmentId: 1 });
        sync.destroy();
        sync.destroy(); // no error
    });
});
