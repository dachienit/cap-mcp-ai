import { useEffect, useState } from 'react';

function App() {
  const [userInfo, setUserInfo] = useState(null);
  const [status, setStatus] = useState('Fetching user info & CSRF token...');
  const [csrfToken, setCsrfToken] = useState(null);

  const [destinationName, setDestinationName] = useState('T4X_011');
  const [bomData, setBomData] = useState(null);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    async function fetchCsrfTokenAndUser() {
      try {
        console.log('🔐 Fetching CSRF token...');
        const response = await fetch('/api/me', {
          method: 'GET',
          headers: {
            'X-CSRF-Token': 'Fetch'
          }
        });

        const token = response.headers.get('X-CSRF-Token');
        if (token) {
          setCsrfToken(token);
          console.log('✅ CSRF token fetched successfully');
        } else {
          console.warn('⚠️ No CSRF token in response headers');
        }

        if (response.ok) {
          const data = await response.json();
          setUserInfo(data);
          setStatus('');
        } else {
          setStatus('Error fetching user data. (Not authenticated)');
        }

      } catch (error) {
        console.error('❌ Error fetching:', error);
        setStatus('Error: ' + error.message);
      }
    }

    fetchCsrfTokenAndUser();
  }, []);

  // Fetch BOM Categories from the On-Premise System using the dynamically input destination
  const handleFetchBom = async () => {
    setBomData(null);
    setFetchError('');
    if (!destinationName) {
      setFetchError('Please enter a destination name.');
      return;
    }
    try {
      const res = await fetch('/api/fetch-bom', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrfToken || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ destinationName: destinationName })
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setBomData(result.data);
      } else {
        setFetchError(result.error || 'Failed to fetch OData');
        console.error(result.details);
      }
    } catch (e) {
      setFetchError('POST fetch action failed: ' + e.message);
    }
  };
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>BTP User Application Dashboard</h1>
      {status && <p style={{ color: '#666' }}>{status}</p>}

      {userInfo && (
        <div style={{ background: '#f0f4f8', padding: '1.5rem', borderRadius: '8px', marginBottom: '1rem', border: '1px solid #d1d5db' }}>
          <h2 style={{ marginTop: 0, color: '#1e3a8a' }}>👤 Profile: {userInfo.firstName} {userInfo.lastName}</h2>
          <p><strong>Email:</strong> {userInfo.email}</p>
          <p><strong>Login Name:</strong> {userInfo.userId}</p>
        </div>
      )}

      {userInfo && (
        <div style={{ marginTop: '2rem', padding: '1rem', borderTop: '1px solid #eee' }}>
          <h3>BOM External Data Fetch (OData)</h3>
          {csrfToken ? (
            <p style={{ fontSize: '0.9em', color: '#555' }}>CSRF Token stored: <code>{csrfToken.substring(0, 10)}...</code></p>
          ) : (
            <p style={{ fontSize: '0.9em', color: '#888' }}><em>Local Dev Mode: No CSRF token required.</em></p>
          )}

          <div style={{ marginBottom: '10px' }}>
            <label style={{ marginRight: '10px' }}><strong>BTP Destination Name:</strong></label>
            <input
              type="text"
              value={destinationName}
              onChange={e => setDestinationName(e.target.value)}
              style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', minWidth: '200px' }}
            />
          </div>

          <button
            onClick={handleFetchBom}
            style={{
              padding: '10px 20px', backgroundColor: '#2563eb',
              color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer',
              fontWeight: 'bold', marginBottom: '10px'
            }}>
            Fetch BOM Categories
          </button>

          {fetchError && <p style={{ color: 'red' }}><strong>Error:</strong> {fetchError}</p>}

          {bomData && bomData.length > 0 && (
            <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
              <h4>Results ({bomData.length})</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1' }}>
                    <th style={{ padding: '12px 8px' }}>Item Category</th>
                    <th style={{ padding: '12px 8px' }}>Language</th>
                    <th style={{ padding: '12px 8px' }}>Category Description</th>
                  </tr>
                </thead>
                <tbody>
                  {bomData.map((item, index) => (
                    <tr key={index} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '12px 8px' }}>{item.BillOfMaterialItemCategory}</td>
                      <td style={{ padding: '12px 8px' }}>{item.Language}</td>
                      <td style={{ padding: '12px 8px' }}>{item.BillOfMaterialItemCategoryDesc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {bomData && bomData.length === 0 && <p>No records found.</p>}
        </div>
      )}
    </div>
  );
}

export default App;
