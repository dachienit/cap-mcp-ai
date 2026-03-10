import { useState } from 'react';
import { getObjectSource, lockObject, setObjectSource, unlock, activateObjects } from '../api.js';

export default function EditorPanel({ destinationName, initialObject, addToast }) {
    const [objectUrl, setObjectUrl] = useState(initialObject?.url || '');
    const [objectName, setObjectName] = useState(initialObject?.name || '');
    const [objectType, setObjectType] = useState(initialObject?.type || 'PROG');
    const [source, setSource] = useState('');
    const [originalSource, setOriginalSource] = useState('');
    const [lockHandle, setLockHandle] = useState(null);
    const [sessionCookie, setSessionCookie] = useState(null);
    const [lockCsrfToken, setLockCsrfToken] = useState(null);
    const [sourceUrl, setSourceUrl] = useState(null); // actual source URL (may differ from objectUrl/source/main)
    const [isLoaded, setIsLoaded] = useState(false);
    const [isDirty, setIsDirty] = useState(false);

    const [loadingState, setLoadingState] = useState(''); // '', 'loading', 'locking', 'saving', 'unlocking', 'activating'

    const busy = !!loadingState;
    const isLocked = !!lockHandle;
    const hasChanges = isDirty && source !== originalSource;

    // ── Load source code
    const handleLoad = async () => {
        const url = objectUrl.trim();
        if (!url) { addToast('Please enter an object URL', 'warning'); return; }
        setLoadingState('loading'); setSource(''); setLockHandle(null); setSessionCookie(null); setLockCsrfToken(null); setSourceUrl(null); setIsLoaded(false);
        try {
            const res = await getObjectSource(destinationName, url);
            setSource(res.source || '');
            setOriginalSource(res.source || '');
            setSourceUrl(res.sourceUrl || null); // save actual source URL for set-source
            setIsLoaded(true); setIsDirty(false);
            addToast('Source loaded successfully', 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoadingState(''); }
    };

    // ── Lock
    const handleLock = async () => {
        setLoadingState('locking');
        try {
            const res = await lockObject(destinationName, objectUrl.trim());
            setLockHandle(res.lockHandle);
            setSessionCookie(res.sessionCookie || null);
            setLockCsrfToken(res.csrfToken || null);
            addToast(`🔒 Object locked (handle: ${res.lockHandle?.substring(0, 12)}…)`, 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoadingState(''); }
    };

    // ── Save source
    const handleSave = async () => {
        if (!isLocked) { addToast('Lock the object first before saving', 'warning'); return; }
        setLoadingState('saving');
        try {
            // Pass sourceUrl so backend uses the correct include URL (critical for ABAP Classes)
            await setObjectSource(destinationName, objectUrl.trim(), lockHandle, source, sourceUrl, sessionCookie, lockCsrfToken);
            setOriginalSource(source); setIsDirty(false);
            addToast('✅ Source saved successfully', 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoadingState(''); }
    };

    // ── Unlock
    const handleUnlock = async () => {
        if (!isLocked) return;
        setLoadingState('unlocking');
        try {
            await unlock(destinationName, objectUrl.trim(), lockHandle, sessionCookie, lockCsrfToken);
            setLockHandle(null);
            setSessionCookie(null);
            setLockCsrfToken(null);
            addToast('🔓 Object unlocked', 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoadingState(''); }
    };

    // ── Activate
    const handleActivate = async () => {
        if (!objectName.trim()) { addToast('Object name is required to activate', 'warning'); return; }
        setLoadingState('activating');
        try {
            const res = await activateObjects(destinationName, [
                { name: objectName.trim(), type: objectType, url: objectUrl.trim() }
            ]);
            addToast(res.message || '⚡ Activation complete!', 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoadingState(''); }
    };

    const handleSourceChange = (e) => {
        setSource(e.target.value);
        setIsDirty(true);
    };

    const lockBarStatus = isLocked ? 'locked' : (isLoaded ? 'loaded' : 'unlocked');

    return (
        <div className="panel">
            {/* ── Object Loader Card ──────────────────────── */}
            <div className="card">
                <div className="card-title">
                    <span className="icon icon-blue">📂</span>
                    Load ABAP Object
                </div>
                <div className="row">
                    <div className="form-group" style={{ flex: 2 }}>
                        <label className="form-label">Object URL (ADT path)</label>
                        <input
                            id="editor-obj-url"
                            className="form-input"
                            placeholder="/sap/adt/programs/programs/Z_MY_PROGRAM"
                            value={objectUrl}
                            onChange={e => setObjectUrl(e.target.value)}
                            style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Object Name (for activate)</label>
                        <input
                            id="editor-obj-name"
                            className="form-input"
                            placeholder="Z_MY_PROGRAM"
                            value={objectName}
                            onChange={e => setObjectName(e.target.value.toUpperCase())}
                            style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}
                        />
                    </div>
                    <div className="form-group" style={{ flex: '0 0 auto', minWidth: 100 }}>
                        <label className="form-label">Type</label>
                        <select id="editor-obj-type" className="form-select" value={objectType} onChange={e => setObjectType(e.target.value)}>
                            {['PROG', 'CLAS', 'INTF', 'FUNC', 'FUGR', 'DTEL', 'TABL'].map(t => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group" style={{ flex: '0 0 auto' }}>
                        <label className="form-label">&nbsp;</label>
                        <button
                            id="btn-load-source"
                            className="btn btn-primary"
                            onClick={handleLoad}
                            disabled={busy}
                        >
                            {loadingState === 'loading' ? <><span className="spinner" /> Loading…</> : <>📂 Load Source</>}
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Editor Card ─────────────────────────────── */}
            <div className="card">
                <div className="card-title">
                    <span className="icon icon-purple">💻</span>
                    Source Code Editor
                    {hasChanges && (
                        <span style={{ marginLeft: 'auto', background: 'var(--warning-light)', color: 'var(--warning)', borderRadius: 'var(--radius-full)', padding: '2px 10px', fontSize: 12 }}>
                            ● Unsaved changes
                        </span>
                    )}
                </div>

                {/* Lock status bar */}
                <div className={`lock-bar ${lockBarStatus}`}>
                    <span>
                        {isLocked
                            ? `🔒 Locked for editing — Handle: ${lockHandle?.substring(0, 20)}…`
                            : isLoaded
                                ? '🟢 Source loaded — Lock to edit'
                                : '⚪ No object loaded'}
                    </span>
                    {isLocked && (
                        <button id="btn-inline-unlock" className="btn btn-sm btn-ghost" onClick={handleUnlock} disabled={busy}>
                            {loadingState === 'unlocking' ? <span className="spinner spinner-dark" /> : '🔓'}
                            Unlock
                        </button>
                    )}
                </div>

                <textarea
                    id="source-editor"
                    className="form-textarea code-editor"
                    value={source}
                    onChange={handleSourceChange}
                    placeholder={isLoaded ? '' : `Enter an Object URL above and click "Load Source" to begin editing.\n\nExample:\n  /sap/adt/programs/programs/Z_MY_PROGRAM`}
                    readOnly={!isLocked}
                    spellCheck={false}
                    style={{ opacity: isLoaded ? 1 : 0.7 }}
                />

                {/* Action buttons */}
                <div className="btn-group">
                    <button
                        id="btn-lock"
                        className="btn btn-warning"
                        onClick={handleLock}
                        disabled={busy || !isLoaded || isLocked}
                        title="Lock object for exclusive editing"
                    >
                        {loadingState === 'locking' ? <><span className="spinner" /> Locking…</> : <>🔒 Lock</>}
                    </button>

                    <button
                        id="btn-save-source"
                        className="btn btn-success"
                        onClick={handleSave}
                        disabled={busy || !isLocked}
                        title="Save source to on-prem system"
                    >
                        {loadingState === 'saving' ? <><span className="spinner" /> Saving…</> : <>💾 Save Source</>}
                    </button>

                    <button
                        id="btn-unlock"
                        className="btn btn-ghost"
                        onClick={handleUnlock}
                        disabled={busy || !isLocked}
                        title="Release lock"
                    >
                        {loadingState === 'unlocking' ? <><span className="spinner spinner-dark" /> Unlocking…</> : <>🔓 Unlock</>}
                    </button>

                    <button
                        id="btn-activate"
                        className="btn btn-primary"
                        onClick={handleActivate}
                        disabled={busy || !isLoaded}
                        title="Activate object in ABAP system"
                    >
                        {loadingState === 'activating' ? <><span className="spinner" /> Activating…</> : <>⚡ Activate</>}
                    </button>
                </div>

                {/* Workflow hint */}
                {isLoaded && !isLocked && (
                    <div className="alert info" style={{ marginTop: 'var(--space-3)' }}>
                        <span>💡</span>
                        <div>
                            <strong>Editing Workflow:</strong> Lock → Edit source → Save → Unlock → Activate
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
