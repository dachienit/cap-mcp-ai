import { useState, useEffect, useCallback } from 'react';
import './index.css';
import { fetchUserInfo } from './api.js';
import SearchPanel from './components/SearchPanel.jsx';
import CreatePanel from './components/CreatePanel.jsx';
import EditorPanel from './components/EditorPanel.jsx';

const TABS = [
  { id: 'search', icon: '🔍', label: 'Search' },
  { id: 'create', icon: '✨', label: 'Create Object' },
  { id: 'editor', icon: '💻', label: 'Editor' },
];

// ─── Toast Manager ────────────────────────────────────────────────────────────
function useToasts() {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  return { toasts, addToast };
}

const TOAST_ICONS = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };

function ToastArea({ toasts }) {
  return (
    <div className="toast-area">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          <span>{TOAST_ICONS[t.type] || 'ℹ️'}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState('search');
  const [destinationName, setDestinationName] = useState('T4X_011');
  const [userInfo, setUserInfo] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading'); // 'loading' | 'ok' | 'error'
  const { toasts, addToast } = useToasts();

  // Pre-fill editor from Search (cross-panel object selection)
  const [selectedObject, setSelectedObject] = useState(null);

  useEffect(() => {
    fetchUserInfo()
      .then(u => { setUserInfo(u); setAuthStatus('ok'); })
      .catch(() => setAuthStatus('error'));
  }, []);

  const handleSelectFromSearch = (obj) => {
    setSelectedObject(obj);
    setActiveTab('editor');
    addToast(`Opening ${obj.name} in Editor`, 'info');
  };

  // Initials for avatar
  const initials = userInfo
    ? `${(userInfo.firstName || userInfo.userId || 'U')[0]}${(userInfo.lastName || '')[0] || ''}`.toUpperCase()
    : '?';

  return (
    <>
      <ToastArea toasts={toasts} />
      <div className="app-shell">
        {/* ─── Header ─────────────────────────────── */}
        <header className="app-header">
          <div className="header-brand">
            <div className="brand-icon">🛰️</div>
            <div>
              <div className="brand-title">MCP ADT Manager</div>
              <div className="brand-sub">SAP ABAP Development via BTP</div>
            </div>
          </div>

          <div className="header-right">
            {/* Destination selector */}
            <div className="destination-selector">
              <label htmlFor="destination-input">Destination</label>
              <input
                id="destination-input"
                className="destination-input"
                value={destinationName}
                onChange={e => setDestinationName(e.target.value)}
                title="BTP Destination Name for on-premise connection"
              />
            </div>

            {/* User badge */}
            {authStatus === 'loading' && (
              <div className="user-badge">
                <span className="spinner spinner-dark" style={{ borderColor: 'var(--accent-light)', borderTopColor: 'var(--accent)' }} />
              </div>
            )}
            {authStatus === 'ok' && userInfo && (
              <div className="user-badge" title={`${userInfo.email}\n${userInfo.userId}`}>
                <div className="user-avatar">{initials}</div>
                <span className="user-name">{userInfo.firstName || userInfo.userId}</span>
              </div>
            )}
            {authStatus === 'error' && (
              <div className="user-badge" style={{ background: 'var(--danger-light)' }}>
                <span style={{ color: 'var(--danger)', fontSize: 13 }}>⚠️ Not authenticated</span>
              </div>
            )}
          </div>
        </header>

        {/* ─── Tab Bar ────────────────────────────── */}
        <nav className="tab-bar" role="tablist">
          {TABS.map(tab => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span>{tab.label}</span>
              {tab.id === 'editor' && selectedObject && (
                <span style={{
                  background: 'rgba(255,255,255,0.25)',
                  borderRadius: 'var(--radius-full)',
                  padding: '0 6px', fontSize: 11, fontWeight: 700
                }}>
                  {selectedObject.name?.substring(0, 12)}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* ─── Tab Panels ─────────────────────────── */}
        <main role="tabpanel">
          {activeTab === 'search' && (
            <SearchPanel
              destinationName={destinationName}
              onSelectObject={handleSelectFromSearch}
              addToast={addToast}
            />
          )}
          {activeTab === 'create' && (
            <CreatePanel
              destinationName={destinationName}
              addToast={addToast}
            />
          )}
          {activeTab === 'editor' && (
            <EditorPanel
              destinationName={destinationName}
              initialObject={selectedObject}
              addToast={addToast}
            />
          )}
        </main>

        {/* ─── Footer ─────────────────────────────── */}
        <footer style={{ textAlign: 'center', padding: 'var(--space-5)', color: 'var(--text-tertiary)', fontSize: 12 }}>
          MCP ADT Manager · SAP BTP ↔ On-Premise · {process.env.NODE_ENV === 'production' ? '🌐 Production' : '🧪 Local Dev (Mock Data)'}
        </footer>
      </div>
    </>
  );
}
