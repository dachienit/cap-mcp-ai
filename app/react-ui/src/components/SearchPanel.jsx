import { useState } from 'react';
import { searchObject, searchPackage, getObjectSource } from '../api.js';

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

export default function SearchPanel({ destinationName, isLoggedIn, onSelectObject, addToast }) {
    // ── Object Search state
    const [objQuery, setObjQuery] = useState('');
    const [objType, setObjType] = useState('');
    const [objMaxResults, setObjMaxResults] = useState(50);
    const [objFilterText, setObjFilterText] = useState('');
    const [objResults, setObjResults] = useState(null);
    const [objLoading, setObjLoading] = useState(false);
    const [selectedObj, setSelectedObj] = useState(null);

    // ── Package Search state
    const [pkgQuery, setPkgQuery] = useState('');
    const [pkgMaxResults, setPkgMaxResults] = useState(200);
    const [pkgFilterText, setPkgFilterText] = useState('');
    const [pkgResults, setPkgResults] = useState(null);
    const [pkgLoading, setPkgLoading] = useState(false);
    const [selectedPkgObj, setSelectedPkgObj] = useState(null);

    // ── Source Hover state
    const [hoverSource, setHoverSource] = useState({ show: false, url: null, code: '', loading: false, x: 0, y: 0 });
    const [hoverTimeout, setHoverTimeout] = useState(null);

    // ── Search Objects
    const handleSearchObj = async () => {
        if (!objQuery.trim()) { addToast('Please enter a search term', 'warning'); return; }
        setObjLoading(true); setObjResults(null); setSelectedObj(null); setObjFilterText('');
        try {
            const limit = parseInt(objMaxResults, 10) || 50;
            const result = await searchObject(destinationName, objQuery.trim(), objType, limit);
            setObjResults(result.data || []);
            if (!result.data?.length) addToast('No objects found', 'info');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setObjLoading(false); }
    };

    // ── Search Packages
    const handleSearchPkg = async () => {
        if (!pkgQuery.trim()) { addToast('Please enter a search term', 'warning'); return; }
        setPkgLoading(true); setPkgResults(null); setSelectedPkgObj(null); setPkgFilterText('');
        try {
            const limit = parseInt(pkgMaxResults, 10) || 200;
            const result = await searchPackage(destinationName, pkgQuery.trim(), limit);
            setPkgResults(result.data || []);
            if (!result.data?.length) addToast('No packages found', 'info');
        } catch (e) {
            addToast(e.message, 'error');
        } finally { setPkgLoading(false); }
    };

    const handleKeyDown = (e, fn) => { if (e.key === 'Enter') fn(); };

    // ── Hover Source
    const handleMouseEnterSource = async (e, objUrl) => {
        if (!objUrl) return;
        if (hoverTimeout) clearTimeout(hoverTimeout);
        const rect = e.target.getBoundingClientRect();
        
        // Use previous source if it's the same URL
        const isSame = hoverSource.url === objUrl;
        
        // Position: closer to the left of the button, larger size
        setHoverSource(prev => ({ 
            ...prev, 
            show: true, 
            url: objUrl, 
            loading: !isSame,
            code: isSame ? prev.code : '',
            x: rect.left - 805, 
            y: rect.top - 10 
        }));

        if (!isSame) {
            try {
                const result = await getObjectSource(destinationName, objUrl);
                setHoverSource(prev => ({ ...prev, code: result.source || 'No source code available.', loading: false }));
            } catch (err) {
                setHoverSource(prev => ({ ...prev, code: `Error loading source: ${err.message}`, loading: false }));
            }
        }
    };

    const handleMouseLeaveSource = () => {
        const timeout = setTimeout(() => {
            setHoverSource(prev => ({ ...prev, show: false }));
        }, 400); // 400ms delay to allow moving to popup
        setHoverTimeout(timeout);
    };

    const handleMouseEnterPopup = () => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
    };

    // ── Filter Data
    const filterData = (data, filterText) => {
        if (!data) return null;
        if (!filterText) return data;
        const lowFilter = filterText.toLowerCase();
        return data.filter(item => 
            (item.name || '').toLowerCase().includes(lowFilter) ||
            (item.description || '').toLowerCase().includes(lowFilter) ||
            (item.type || '').toLowerCase().includes(lowFilter)
        );
    };

    const filteredObjResults = filterData(objResults, objFilterText);
    const filteredPkgResults = filterData(pkgResults, pkgFilterText)?.sort((a, b) => {
        const tA = (a.type || 'DEVC').toUpperCase();
        const tB = (b.type || 'DEVC').toUpperCase();
        if (tA < tB) return -1;
        if (tA > tB) return 1;
        return (a.name || '').localeCompare(b.name || '');
    });

    return (
        <div className="panel" style={{ position: 'relative' }}>
            {/* ── Hover Source Popup ── */}
            {hoverSource.show && (
                <div 
                    className="source-popup card shadow-md"
                    onMouseEnter={handleMouseEnterPopup}
                    onMouseLeave={handleMouseLeaveSource}
                    style={{ 
                        position: 'fixed', 
                        left: hoverSource.x, 
                        top: hoverSource.y, 
                        zIndex: 9999, 
                        width: '800px', 
                        height: '600px', 
                        display: 'flex', 
                        flexDirection: 'column' 
                    }}
                >
                    <div className="card-title" style={{ padding: '10px 16px', fontSize: '14px', backgroundColor: '#f5f7fb', borderBottom: '1px solid #dde3ed', display: 'flex', justifyContent: 'space-between' }}>
                        <span>Source Preview</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-hint)' }}>Hover out to close</span>
                    </div>
                    <div style={{ padding: '0', overflowY: 'auto', flex: 1, backgroundColor: '#ffffff', margin: 0 }}>
                        {hoverSource.loading ? (
                            <div style={{ color: 'var(--text-hint)', fontSize: '13px', padding: '20px', textAlign: 'center' }}>
                                <span className="spinner spinner-dark" style={{ marginRight: '8px' }} />
                                Loading source code...
                            </div>
                        ) : (
                            <pre style={{ 
                                margin: 0, 
                                padding: '16px',
                                fontSize: '12px', 
                                fontFamily: 'var(--font-mono)', 
                                color: 'var(--text-body)', 
                                whiteSpace: 'pre',
                                lineHeight: '1.5'
                            }}>
                                {hoverSource.code}
                            </pre>
                        )}
                    </div>
                </div>
            )}

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
                    <div className="form-group" style={{ flex: '0 0 auto', width: '90px' }}>
                        <label className="form-label" title="Maximum results to fetch from ADT">Max Results</label>
                        <input
                            type="number"
                            className="form-input"
                            value={objMaxResults}
                            onChange={e => setObjMaxResults(e.target.value)}
                            min="1"
                            max="5000"
                        />
                    </div>
                    <div className="form-group" style={{ flex: '0 0 auto' }}>
                        <label className="form-label">&nbsp;</label>
                        <button
                            id="btn-search-obj"
                            className="btn btn-primary"
                            onClick={handleSearchObj}
                            disabled={objLoading || !isLoggedIn}
                        >
                            {objLoading ? <><span className="spinner" />Searching…</> : 'Search'}
                        </button>
                        {!isLoggedIn && <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>Connect first</div>}
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
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-4)', gap: '1rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Filter results..."
                                    value={objFilterText}
                                    onChange={e => setObjFilterText(e.target.value)}
                                    style={{ maxWidth: '250px', padding: '0.3rem 0.6rem', fontSize: '13px' }}
                                />
                                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                    Showing {filteredObjResults.length} / {objResults.length}
                                    {selectedObj ? ' — 1 selected' : ''}
                                </span>
                            </div>
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
                        <div className="list-view-container" style={{ borderTop: '1px solid var(--separator)', paddingTop: '1rem' }}>
                            {filteredObjResults.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-secondary)' }}>No matches for filter</div>
                            ) : filteredObjResults.map((obj, i) => (
                                <div
                                    key={i}
                                    className={`list-card ${selectedObj === obj ? 'selected' : ''}`}
                                    onClick={() => setSelectedObj(obj === selectedObj ? null : obj)}
                                >
                                    <div className="list-card-badge-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div className={`list-card-badge ${obj.type}`}>{obj.type}</div>
                                        {obj.url && obj.type !== 'DEVC' && (
                                            <div 
                                                className="source-preview-btn"
                                                onMouseEnter={(e) => handleMouseEnterSource(e, obj.url)}
                                                onMouseLeave={handleMouseLeaveSource}
                                            >Source</div>
                                        )}
                                    </div>
                                    <div className="list-card-title">{obj.name}</div>
                                    <div className="list-card-meta">
                                        <div className="meta-col">
                                            <span className="meta-label">Type</span>
                                            <span className="meta-value">{obj.type}</span>
                                        </div>
                                        <div className="meta-col" style={{ flex: 1, minWidth: '150px' }}>
                                            <span className="meta-label">Description</span>
                                            <span className="meta-value" style={{ color: 'var(--text-secondary)' }}>{obj.description || '—'}</span>
                                        </div>
                                        <div className="meta-col">
                                            <span className="meta-label">System</span>
                                            <span className="meta-value">{destinationName || '—'}</span>
                                        </div>
                                        <div className="meta-col">
                                            <span className="meta-label">Package</span>
                                            <span className="meta-value">{obj.packageName || '—'}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
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
                    <div className="form-group" style={{ flex: '0 0 auto', width: '90px' }}>
                        <label className="form-label" title="Maximum results to fetch from ADT">Max Results</label>
                        <input
                            type="number"
                            className="form-input"
                            value={pkgMaxResults}
                            onChange={e => setPkgMaxResults(e.target.value)}
                            min="1"
                            max="5000"
                        />
                    </div>
                    <div className="form-group" style={{ flex: '0 0 auto' }}>
                        <label className="form-label">&nbsp;</label>
                        <button
                            id="btn-search-pkg"
                            className="btn btn-purple"
                            onClick={handleSearchPkg}
                            disabled={pkgLoading || !isLoggedIn}
                        >
                            {pkgLoading ? <><span className="spinner" />Searching…</> : 'Search'}
                        </button>
                        {!isLoggedIn && <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px' }}>Connect first</div>}
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
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-4)', gap: '1rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Filter results..."
                                    value={pkgFilterText}
                                    onChange={e => setPkgFilterText(e.target.value)}
                                    style={{ maxWidth: '250px', padding: '0.3rem 0.6rem', fontSize: '13px' }}
                                />
                                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                    Showing {filteredPkgResults.length} / {pkgResults.length}
                                    {selectedPkgObj ? ' — 1 selected' : ''}
                                </span>
                            </div>
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
                        <div className="list-view-container" style={{ borderTop: '1px solid var(--separator)', paddingTop: '1rem' }}>
                            {filteredPkgResults.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-secondary)' }}>No matches for filter</div>
                            ) : filteredPkgResults.map((pkg, i) => {
                                const isSelectable = pkg.type !== 'DEVC';
                                return (
                                    <div
                                        key={i}
                                        className={`list-card ${selectedPkgObj === pkg ? 'selected' : ''}`}
                                        onClick={() => isSelectable ? setSelectedPkgObj(pkg === selectedPkgObj ? null : pkg) : null}
                                        style={{ cursor: isSelectable ? 'pointer' : 'default' }}
                                        title={!isSelectable ? 'Packages cannot be opened in editor' : ''}
                                    >
                                        <div className="list-card-badge-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div className={`list-card-badge ${pkg.type || 'DEVC'}`}>{pkg.type || 'DEVC'}</div>
                                            {pkg.url && pkg.type !== 'DEVC' && (
                                                <div 
                                                    className="source-preview-btn"
                                                    onMouseEnter={(e) => handleMouseEnterSource(e, pkg.url)}
                                                    onMouseLeave={handleMouseLeaveSource}
                                                    onClick={(e) => e.stopPropagation()}
                                                >Source</div>
                                            )}
                                        </div>
                                        <div className="list-card-title">{pkg.name}</div>
                                        <div className="list-card-meta">
                                            <div className="meta-col">
                                                <span className="meta-label">Type</span>
                                                <span className="meta-value">{pkg.type || 'DEVC'}</span>
                                            </div>
                                            <div className="meta-col" style={{ flex: 1, minWidth: '150px' }}>
                                                <span className="meta-label">Description</span>
                                                <span className="meta-value" style={{ color: 'var(--text-secondary)' }}>{pkg.description || '—'}</span>
                                            </div>
                                            <div className="meta-col">
                                                <span className="meta-label">System</span>
                                                <span className="meta-value">{destinationName || '—'}</span>
                                            </div>
                                            <div className="meta-col">
                                                <span className="meta-label">Package / Scope</span>
                                                <span className="meta-value">{pkg.packageName || pkg.superPackage || '—'}</span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
