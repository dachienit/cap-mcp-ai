import { useState } from 'react';
import { searchObject, searchPackage } from '../api.js';

const OBJECT_TYPES = [
    { value: '', label: 'All Types' },
    { value: 'PROG', label: 'Program (PROG)' },
    { value: 'CLAS', label: 'Class (CLAS)' },
    { value: 'INTF', label: 'Interface (INTF)' },
    { value: 'FUNC', label: 'Function Module (FUNC)' },
    { value: 'FUGR', label: 'Function Group (FUGR)' },
    { value: 'DTEL', label: 'Data Element (DTEL)' },
    { value: 'TABL', label: 'Table (TABL)' },
    { value: 'MSAG', label: 'Message Class (MSAG)' },
];

export default function SearchPanel({ destinationName, onSelectObject, addToast }) {
    // ── Object Search state
    const [objQuery, setObjQuery] = useState('');
    const [objType, setObjType] = useState('');
    const [objResults, setObjResults] = useState(null);
    const [objLoading, setObjLoading] = useState(false);
    const [selectedObj, setSelectedObj] = useState(null);

    // ── Package Search state
    const [pkgQuery, setPkgQuery] = useState('');
    const [pkgResults, setPkgResults] = useState(null);
    const [pkgLoading, setPkgLoading] = useState(false);
    const [selectedPkgObj, setSelectedPkgObj] = useState(null);

    // ── Search Objects
    const handleSearchObj = async () => {
        if (!objQuery.trim()) { addToast('Please enter a search term', 'warning'); return; }
        setObjLoading(true); setObjResults(null); setSelectedObj(null);
        try {
            const result = await searchObject(destinationName, objQuery.trim(), objType);
            setObjResults(result.data || []);
            if (!result.data?.length) addToast('No objects found', 'info');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setObjLoading(false); }
    };

    // ── Search Packages
    const handleSearchPkg = async () => {
        if (!pkgQuery.trim()) { addToast('Please enter a search term', 'warning'); return; }
        setPkgLoading(true); setPkgResults(null); setSelectedPkgObj(null);
        try {
            const result = await searchPackage(destinationName, pkgQuery.trim());
            setPkgResults(result.data || []);
            if (!result.data?.length) addToast('No packages found', 'info');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setPkgLoading(false); }
    };

    const handleKeyDown = (e, fn) => { if (e.key === 'Enter') fn(); };

    return (
        <div className="panel">
            {/* ── Object Search ─────────────────────────────── */}
            <div className="card">
                <div className="card-title">
                    <span className="icon icon-blue">&#9906;</span>
                    Search ABAP Objects
                </div>
                <div className="row">
                    <div className="form-group" style={{ flex: 2 }}>
                        <label className="form-label">Object Name / Pattern</label>
                        <input
                            id="search-obj-query"
                            className="form-input"
                            placeholder="e.g. Z_MY_PROG* or CL_SALV*"
                            value={objQuery}
                            onChange={e => setObjQuery(e.target.value)}
                            onKeyDown={e => handleKeyDown(e, handleSearchObj)}
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Object Type</label>
                        <select
                            id="search-obj-type"
                            className="form-select"
                            value={objType}
                            onChange={e => setObjType(e.target.value)}
                        >
                            {OBJECT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </div>
                    <div className="form-group" style={{ flex: '0 0 auto' }}>
                        <label className="form-label">&nbsp;</label>
                        <button
                            id="btn-search-obj"
                            className="btn btn-primary"
                            onClick={handleSearchObj}
                            disabled={objLoading}
                        >
                            {objLoading ? <><span className="spinner" />Searching…</> : 'Search'}
                        </button>
                    </div>
                </div>

                {objResults !== null && objResults.length === 0 && (
                    <div className="empty-state" style={{ padding: '2rem' }}>
                        <div className="empty-icon">○</div>
                        <div className="empty-title">No objects found</div>
                        <div className="empty-desc">Try a different search term or object type</div>
                    </div>
                )}

                {objResults && objResults.length > 0 && (
                    <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-4)' }}>
                            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                {objResults.length} result{objResults.length !== 1 ? 's' : ''}
                                {selectedObj ? ' — 1 selected' : ''}
                            </span>
                            {selectedObj && (
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={() => onSelectObject(selectedObj)}
                                    id="btn-open-in-editor"
                                >
                                    Open in Editor
                                </button>
                            )}
                        </div>
                        <div className="table-wrapper">
                            <table className="result-table">
                                <thead>
                                    <tr>
                                        <th>Type</th>
                                        <th>Name</th>
                                        <th>Description</th>
                                        <th>Package</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {objResults.map((obj, i) => (
                                        <tr
                                            key={i}
                                            className={selectedObj === obj ? 'selected' : ''}
                                            onClick={() => setSelectedObj(obj === selectedObj ? null : obj)}
                                        >
                                            <td><span className={`type-badge ${obj.type}`}>{obj.type}</span></td>
                                            <td>
                                                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, fontSize: 13 }}>
                                                    {obj.name}
                                                </span>
                                            </td>
                                            <td style={{ color: 'var(--text-secondary)' }}>{obj.description || '—'}</td>
                                            <td>
                                                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#0077a8' }}>
                                                    {obj.packageName || '—'}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>

            {/* ── Package Search ────────────────────────────── */}
            <div className="card">
                <div className="card-title">
                    <span className="icon icon-purple">&#9783;</span>
                    Search Packages
                </div>
                <div className="row">
                    <div className="form-group" style={{ flex: 2 }}>
                        <label className="form-label">Package Name / Pattern</label>
                        <input
                            id="search-pkg-query"
                            className="form-input"
                            placeholder="e.g. ZLOCAL* or Z_MRP*"
                            value={pkgQuery}
                            onChange={e => setPkgQuery(e.target.value)}
                            onKeyDown={e => handleKeyDown(e, handleSearchPkg)}
                        />
                    </div>
                    <div className="form-group" style={{ flex: '0 0 auto' }}>
                        <label className="form-label">&nbsp;</label>
                        <button
                            id="btn-search-pkg"
                            className="btn btn-purple"
                            onClick={handleSearchPkg}
                            disabled={pkgLoading}
                        >
                            {pkgLoading ? <><span className="spinner" />Searching…</> : 'Search'}
                        </button>
                    </div>
                </div>

                {pkgResults !== null && pkgResults.length === 0 && (
                    <div className="empty-state" style={{ padding: '2rem' }}>
                        <div className="empty-icon">○</div>
                        <div className="empty-title">No packages found</div>
                    </div>
                )}

                {pkgResults && pkgResults.length > 0 && (
                    <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-4)' }}>
                            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                {pkgResults.length} result{pkgResults.length !== 1 ? 's' : ''}
                                {selectedPkgObj ? ' — 1 selected' : ''}
                            </span>
                            {selectedPkgObj && (
                                <button
                                    className="btn btn-purple btn-sm"
                                    onClick={() => onSelectObject(selectedPkgObj)}
                                    id="btn-open-pkg-obj"
                                >
                                    Open in Editor
                                </button>
                            )}
                        </div>
                        <div className="table-wrapper">
                            <table className="result-table">
                                <thead>
                                    <tr>
                                        <th>Type</th>
                                        <th>Name</th>
                                        <th>Description</th>
                                        <th>Package / Scope</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pkgResults.map((pkg, i) => {
                                        const isSelectable = pkg.type !== 'DEVC';
                                        return (
                                            <tr 
                                                key={i}
                                                className={selectedPkgObj === pkg ? 'selected' : ''}
                                                onClick={() => isSelectable ? setSelectedPkgObj(pkg === selectedPkgObj ? null : pkg) : null}
                                                style={{ cursor: isSelectable ? 'pointer' : 'default' }}
                                                title={!isSelectable ? 'Packages cannot be opened in editor' : ''}
                                            >
                                                <td><span className={`type-badge ${pkg.type || 'DEVC'}`}>{pkg.type || 'DEVC'}</span></td>
                                                <td>
                                                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, fontSize: 13 }}>
                                                        {pkg.name}
                                                    </span>
                                                </td>
                                                <td style={{ color: 'var(--text-secondary)' }}>{pkg.description || '—'}</td>
                                                <td>
                                                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#0077a8' }}>
                                                        {pkg.packageName || pkg.superPackage || '—'}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
