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
        var _pendingExternalChange = null;
        var _externalChangeRetry = null;
        var POLL_MS = (options && options.pollIntervalMs) || 10000;
        var EXTERNAL_CHANGE_MAX_RETRIES = Math.ceil(8000 / 50);

        function _emit(name, data) {
            (_callbacks[name] || []).forEach(function (cb) { cb(data); });
        }

        function _emitExternalChangeWhenSafe(data) {
            if (_destroyed) return;
            _pendingExternalChange = data;

            if (typeof options.isDrawingFn === 'function' && options.isDrawingFn()) {
                if (!_externalChangeRetry) {
                    // Bounded in retries: unbounded, a stroke that never settles
                    // means an external annotation change is never surfaced, so
                    // the viewer silently shows stale annotations forever.
                    var attempts = 0;
                    _externalChangeRetry = setTimeout(function retryExternalChange() {
                        _externalChangeRetry = null;
                        if (_destroyed) return;
                        attempts += 1;
                        if (attempts < EXTERNAL_CHANGE_MAX_RETRIES
                            && typeof options.isDrawingFn === 'function'
                            && options.isDrawingFn()) {
                            _externalChangeRetry = setTimeout(retryExternalChange, 50);
                            return;
                        }
                        var pending = _pendingExternalChange;
                        _pendingExternalChange = null;
                        if (pending) _emit('onExternalChange', pending);
                    }, 50);
                }
                return;
            }

            _pendingExternalChange = null;
            _emit('onExternalChange', data);
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
                    _emitExternalChangeWhenSafe({ previousVersion: _currentVersion, newVersion: version });
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
                if (_externalChangeRetry) {
                    clearTimeout(_externalChangeRetry);
                    _externalChangeRetry = null;
                }
                _pendingExternalChange = null;
                _callbacks.onExternalChange = [];
            },
            // For testing
            _checkVersion: checkVersion,
        };

        return handle;
    }

    exports.createVersionSync = createVersionSync;
})(window.PdfPreviewModalVersionSync);
