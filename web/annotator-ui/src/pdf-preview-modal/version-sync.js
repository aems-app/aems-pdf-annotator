window.PdfPreviewModalVersionSync = window.PdfPreviewModalVersionSync || {};

(function (exports) {
    'use strict';

    function createVersionSync(syncState, options) {
        // options: { modeAdapter, submissionId, assignmentId, pollIntervalMs }
        var _callbacks = { onExternalChange: [] };
        var _destroyed = false;
        var _pollInterval = null;
        var _currentVersion = null;
        var _skipNextCycle = false;
        var POLL_MS = (options && options.pollIntervalMs) || 10000;

        function _emit(name, data) {
            (_callbacks[name] || []).forEach(function (cb) { cb(data); });
        }

        function checkVersion() {
            if (_destroyed || _skipNextCycle) {
                _skipNextCycle = false;
                return Promise.resolve();
            }
            var adapter = options && options.modeAdapter;
            if (!adapter || typeof adapter.getAnnotationsVersion !== 'function') {
                return Promise.resolve();
            }
            return adapter.getAnnotationsVersion(
                options.assignmentId, options.submissionId
            ).then(function (response) {
                if (_destroyed) return;
                var version = null;
                if (typeof response === 'string') {
                    version = response;
                } else if (response && typeof response.version === 'string') {
                    if (response.success === false) {
                        return;
                    }
                    version = response.version;
                }
                if (!version) return;
                if (_currentVersion !== null && version !== _currentVersion) {
                    _emit('onExternalChange', { previousVersion: _currentVersion, newVersion: version });
                }
                _currentVersion = version;
                if (syncState) {
                    syncState.versionToken = version;
                    syncState.lastCheckedAt = Date.now();
                }
            }).catch(function () {
                // Silently swallow polling errors
            });
        }

        var handle = {
            onExternalChange: function (cb) { _callbacks.onExternalChange.push(cb); },
            start: function () {
                if (_destroyed || _pollInterval) return;
                _pollInterval = setInterval(checkVersion, POLL_MS);
                if (syncState) syncState.polling = true;
            },
            stop: function () {
                if (_pollInterval) {
                    clearInterval(_pollInterval);
                    _pollInterval = null;
                }
                if (syncState) syncState.polling = false;
            },
            markLocalChange: function (newVersion) {
                _skipNextCycle = true;
                // If the caller knows the new version (e.g. from PUT response mtime),
                // update _currentVersion so subsequent polls don't treat it as external.
                if (newVersion) {
                    _currentVersion = String(newVersion);
                    if (syncState) syncState.versionToken = _currentVersion;
                }
            },
            destroy: function () {
                if (_destroyed) return;
                _destroyed = true;
                handle.stop();
                _callbacks.onExternalChange = [];
            },
            // For testing
            _checkVersion: checkVersion,
        };

        return handle;
    }

    exports.createVersionSync = createVersionSync;
})(window.PdfPreviewModalVersionSync);
