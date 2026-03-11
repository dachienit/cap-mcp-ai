import { useState } from 'react';
import { createObject } from '../api.js';

const OBJECT_TYPES = [
    { value: 'PROG', label: 'Program (PROG)', template: `REPORT z_<name>.\n\nSTART-OF-SELECTION.\n  WRITE: / 'Hello World'.` },
    { value: 'CLAS', label: 'Class (CLAS)', template: `CLASS zcl_<name> DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS: run.\nENDCLASS.\n\nCLASS zcl_<name> IMPLEMENTATION.\n  METHOD run.\n    WRITE: / 'Hello from class'.\n  ENDMETHOD.\nENDCLASS.` },
    { value: 'INTF', label: 'Interface (INTF)', template: `INTERFACE zif_<name> PUBLIC.\n  METHODS: execute.\nENDINTERFACE.` },
    { value: 'FUGR', label: 'Function Group (FUGR)', template: `FUNCTION-POOL z<name>.` },
];

export default function CreatePanel({ destinationName, addToast }) {
    const [form, setForm] = useState({
        objectType: 'PROG',
        name: '',
        packageName: '$TMP',
        description: '',
        responsible: 'DEVELOPER'
    });
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);

    const selectedTypeDef = OBJECT_TYPES.find(t => t.value === form.objectType) || OBJECT_TYPES[0];

    const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

    const handleCreate = async () => {
        if (!form.name.trim()) { addToast('Object name is required', 'warning'); return; }
        if (!form.packageName.trim()) { addToast('Package name is required', 'warning'); return; }

        setLoading(true); setResult(null);
        try {
            const res = await createObject({ ...form, destinationName, name: form.name.toUpperCase(), packageName: form.packageName.toUpperCase() });
            setResult(res);
            addToast(`Object ${form.name.toUpperCase()} created successfully!`, 'success');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setLoading(false); }
    };

    const handleReset = () => {
        setForm({ objectType: 'PROG', name: '', packageName: '$TMP', description: '', responsible: 'DEVELOPER' });
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

                <div className="section-grid">
                    <div className="form-group">
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
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Description</label>
                        <input
                            id="create-obj-desc"
                            className="form-input"
                            placeholder="Short description for the object"
                            value={form.description}
                            onChange={e => update('description', e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Responsible Developer</label>
                        <input
                            id="create-obj-responsible"
                            className="form-input"
                            placeholder="SAP user ID"
                            value={form.responsible}
                            onChange={e => update('responsible', e.target.value.toUpperCase())}
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
                        disabled={loading || !form.name}
                    >
                        {loading ? <><span className="spinner" />Creating…</> : 'Create Object'}
                    </button>
                    <button className="btn btn-ghost" onClick={handleReset} disabled={loading}>
                        ↩ Reset
                    </button>
                </div>
            </div>

            {/* Quick Reference */}
            <div className="card">
                <div className="card-title">
                    <span className="icon icon-orange">i</span>
                    Quick Reference — Naming Conventions
                </div>
                <div className="table-wrapper">
                    <table className="result-table">
                        <thead>
                            <tr><th>Type</th><th>Naming Pattern</th><th>Example</th></tr>
                        </thead>
                        <tbody>
                            {[
                                ['PROG', 'Z_<PREFIX>_<NAME>', 'Z_MRP_REPORT'],
                                ['CLAS', 'ZCL_<NAME>', 'ZCL_ORDER_HANDLER'],
                                ['INTF', 'ZIF_<NAME>', 'ZIF_PROCESSABLE'],
                                ['FUGR', 'Z<NAME>', 'ZMRP_FUNCTIONS'],
                            ].map(([type, pattern, ex]) => (
                                <tr key={type}>
                                    <td><span className={`type-badge ${type}`}>{type}</span></td>
                                    <td><code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{pattern}</code></td>
                                    <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{ex}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
