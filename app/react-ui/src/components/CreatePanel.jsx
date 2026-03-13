import { useState, useEffect } from 'react';
import { createObject, searchObject, getTransports } from '../api.js';

const OBJECT_TYPES = [
    { value: 'PROG', label: 'Program (PROG)', template: `REPORT <name>.\n\nSTART-OF-SELECTION.\n  WRITE: / 'Hello World'.` },
    { value: 'CLAS', label: 'Class (CLAS)', template: `CLASS <name> DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS: run.\nENDCLASS.\n\nCLASS <name> IMPLEMENTATION.\n  METHOD run.\n    WRITE: / 'Hello from class'.\n  ENDMETHOD.\nENDCLASS.` },
    { value: 'INTF', label: 'Interface (INTF)', template: `INTERFACE <name> PUBLIC.\n  METHODS: execute.\nENDINTERFACE.` },
    { value: 'FUGR', label: 'Function Group (FUGR)', template: `FUNCTION-POOL <name>.` },
];

export default function CreatePanel({ destinationName, isLoggedIn, userInfo, addToast }) {
    const defaultResponsible = userInfo?.userId || 'DEVELOPER';

    const [form, setForm] = useState({
        objectType: 'PROG',
        name: '',
        packageName: '$TMP',
        description: '',
        responsible: defaultResponsible,
        transport: ''
    });
    const [loading, setLoading] = useState(false);
    const [loadingTransport, setLoadingTransport] = useState(false);
    const [result, setResult] = useState(null);

    // Keep responsible in sync if userInfo loads later
    useEffect(() => {
        if (userInfo?.userId) {
            setForm(prev => ({ ...prev, responsible: userInfo.userId }));
        }
    }, [userInfo]);

    const selectedTypeDef = OBJECT_TYPES.find(t => t.value === form.objectType) || OBJECT_TYPES[0];

    const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

    const handlePackageBlur = async () => {
        const pkg = form.packageName.trim().toUpperCase();
        if (!pkg || pkg === '$TMP') {
            update('transport', '');
            return;
        }

        setLoadingTransport(true);
        try {
            const res = await getTransports(destinationName, pkg);
            if (res.data && res.data.length > 0) {
                // Pre-fill the first open transport
                update('transport', res.data[0].number);
                addToast(`Found active transport ${res.data[0].number} for package ${pkg}`, 'info');
            } else {
                update('transport', '');
                addToast(`No active transport found for package ${pkg}`, 'warning');
            }
        } catch (e) {
            addToast(`Failed to fetch transports: ${e.message}`, 'error');
        } finally {
            setLoadingTransport(false);
        }
    };

    const handleCreate = async () => {
        if (!form.name.trim()) { addToast('Object name is required', 'warning'); return; }
        if (!form.packageName.trim()) { addToast('Package name is required', 'warning'); return; }

        setLoading(true); setResult(null);
        try {
            // First, check if object already exists
            const searchRes = await searchObject(destinationName, form.name.toUpperCase(), form.objectType, 10);
            const existingObjects = searchRes.data || searchRes.results || [];
            
            // Because BTP backend uses wildcard search (query + '*'), we should check for an exact match
            const exactMatch = existingObjects.find(obj => 
                (obj.name || obj['adtcore:name'] || '').toUpperCase() === form.name.toUpperCase()
            );

            // If there's any result that matches exact name, return error
            if (exactMatch || existingObjects.length > 0) {
                // If the user wants to strictly block *any* search result, we block it here. 
                // But specifically rejecting exact match is safest to not block unrelated objects.
                if (exactMatch) {
                    addToast(`Object ${form.name.toUpperCase()} already exists in the system`, 'error');
                    setLoading(false);
                    return;
                } else {
                    // Just in case existingObjects has items but none match exactly. 
                    // Often the case if user submits "ZCL", and "ZCL_1", "ZCL_2" exist but "ZCL" doesn't.
                    // We'll proceed in this case because the object "ZCL" itself doesn't exist yet.
                }
            }

            const res = await createObject({ ...form, destinationName, name: form.name.toUpperCase(), packageName: form.packageName.toUpperCase() });
            setResult(res);
            addToast(`Object ${form.name.toUpperCase()} created successfully!`, 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoading(false); }
    };

    const handleReset = () => {
        setForm({ objectType: 'PROG', name: '', packageName: '$TMP', description: '', responsible: defaultResponsible, transport: '' });
        setResult(null);
    };

    return (
        <div className="panel">
            <div className="card">
                <div className="card-title">
                    <span className="icon icon-green">+</span>
                    Create New ABAP Object
                </div>

                {/* Type selector pills */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
                    {OBJECT_TYPES.map(t => (
                        <button
                            key={t.value}
                            id={`type-btn-${t.value}`}
                            className={`btn btn-sm ${form.objectType === t.value ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => update('objectType', t.value)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                <div className="section-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label className="form-label">Object Name *</label>
                        <input
                            id="create-obj-name"
                            className="form-input"
                            placeholder="e.g. Z_MY_PROGRAM"
                            value={form.name}
                            onChange={e => update('name', e.target.value.toUpperCase())}
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Package *</label>
                        <input
                            id="create-obj-package"
                            className="form-input"
                            placeholder="e.g. ZLOCAL or $TMP"
                            value={form.packageName}
                            onChange={e => update('packageName', e.target.value.toUpperCase())}
                            onBlur={handlePackageBlur}
                        />
                    </div>
                    <div className="form-group" style={{ position: 'relative' }}>
                        <label className="form-label">Transport Request</label>
                        <input
                            id="create-obj-transport"
                            className="form-input"
                            placeholder="Auto-filled if not $TMP"
                            value={form.transport}
                            onChange={e => update('transport', e.target.value.toUpperCase())}
                            disabled={loadingTransport}
                        />
                        {loadingTransport && <div className="spinner spinner-dark" style={{ position: 'absolute', right: 12, top: 32 }} />}
                    </div>
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label className="form-label">Description</label>
                        <input
                            id="create-obj-desc"
                            className="form-input"
                            placeholder="Short description for the object"
                            value={form.description}
                            onChange={e => update('description', e.target.value)}
                        />
                    </div>
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label className="form-label">Responsible Developer</label>
                        <input
                            id="create-obj-responsible"
                            className="form-input"
                            value={form.responsible}
                            readOnly
                            disabled
                            title="Derived from your logged-in user"
                        />
                    </div>
                </div>

                {/* Preview */}
                <div style={{ marginBottom: 'var(--space-4)' }}>
                    <label className="form-label" style={{ marginBottom: 4, display: 'block' }}>Source Template Preview</label>
                    <pre style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
                        background: '#1e1e2e', color: '#cdd6f4',
                        borderRadius: 'var(--radius-md)', padding: 'var(--space-4)',
                        overflowX: 'auto', lineHeight: 1.7, margin: 0
                    }}>
                        {selectedTypeDef.template.replace(/<name>/g, (form.name || 'EXAMPLE').toLowerCase())}
                    </pre>
                </div>

                {result && (
                    <div className="alert success" style={{ marginBottom: 'var(--sp-3)' }}>
                        <span>&#10003;</span>
                        <div>
                            <div style={{ fontWeight: 600 }}>Object created successfully!</div>
                            {result.objectUrl && (
                                <div className="object-url" style={{ marginTop: 4 }}>{result.objectUrl}</div>
                            )}
                            {result.message && <div style={{ marginTop: 4, fontSize: 12 }}>{result.message}</div>}
                        </div>
                    </div>
                )}

                <div className="btn-group">
                    <button
                        id="btn-create-object"
                        className="btn btn-success"
                        onClick={handleCreate}
                        disabled={loading || !form.name || !isLoggedIn}
                    >
                        {loading ? <><span className="spinner" />Creating…</> : 'Create Object'}
                    </button>
                    {!isLoggedIn && <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>Connect system first</div>}
                    <button className="btn btn-ghost" onClick={handleReset} disabled={loading}>
                        ↩ Reset
                    </button>
                </div>
            </div>

        </div>
    );
}
