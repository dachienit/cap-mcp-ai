import { useEffect, useState } from 'react';

function App() {
  const [userInfo, setUserInfo] = useState(null);
  const [status, setStatus] = useState('Fetching user info & CSRF token...');
  const [csrfToken, setCsrfToken] = useState(null);

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

  const handlePostAction = async () => {
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrfToken || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: "test" })
      });
      const result = await res.json();
      alert(result.message || JSON.stringify(result));
    } catch (e) {
      alert('POST action failed: ' + e.message);
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

      {csrfToken && (
        <div style={{ marginTop: '2rem', padding: '1rem', borderTop: '1px solid #eee' }}>
          <h3>Developer API Testing</h3>
          <p style={{ fontSize: '0.9em', color: '#555' }}>CSRF Token stored: <code>{csrfToken.substring(0, 10)}...</code></p>
          <button
            onClick={handlePostAction}
            style={{
              padding: '10px 20px', backgroundColor: '#2563eb',
              color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer',
              fontWeight: 'bold'
            }}>
            Test POST with CSRF Token
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
