import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

export default function CallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const processedRef = useRef(false);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error');

    if (processedRef.current) return;

    if (errorParam) {
      setError(errorParam);
      return;
    }

    if (!code) {
      setError('No authorization code received');
      return;
    }

    processedRef.current = true;

    const handleCallback = async () => {
      try {
        const data = await api.handleCallback(code, state || undefined);
        api.setToken(data.token);
        await refreshUser();
        // If the user was mid-way through a CLI login, return them to the approval page.
        const cliCode = sessionStorage.getItem('kproxy_cli_code');
        navigate(cliCode ? '/cli' : '/dashboard', { replace: true });
      } catch (err) {
        console.error('Auth callback error:', err);
        setError(err instanceof Error ? err.message : 'Authentication failed');
        // Reset processed flag on error to allow retry if needed (though for invalid code it won't help)
        // processedRef.current = false; 
      }
    };

    handleCallback();
  }, [searchParams, navigate, refreshUser]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <h1 className="text-2xl font-bold text-destructive">Authentication Failed</h1>
        <p className="text-muted-foreground">{error}</p>
        <a href="/" className="text-primary hover:underline">
          Return to Home
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      <p className="text-muted-foreground">Processing login...</p>
    </div>
  );
}
