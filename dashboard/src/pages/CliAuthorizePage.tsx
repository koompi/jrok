import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

const STORE_KEY = 'kproxy_cli_code';

export default function CliAuthorizePage() {
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading } = useAuth();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'approving' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCode(searchParams.get('code') || sessionStorage.getItem(STORE_KEY) || '');
  }, [searchParams]);

  // Not signed in: stash the code and send to the landing page to log in.
  // CallbackPage routes back here after a successful login.
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated && code) {
      sessionStorage.setItem(STORE_KEY, code);
      window.location.href = '/';
    }
  }, [isLoading, isAuthenticated, code]);

  const approve = async () => {
    if (!code) return;
    setStatus('approving');
    setError(null);
    try {
      await api.approveCliAuth(code);
      sessionStorage.removeItem(STORE_KEY);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to authorize the CLI');
      setStatus('error');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3 px-6 text-center">
        <div className="h-14 w-14 rounded-full bg-emerald-500/10 flex items-center justify-center text-2xl">✓</div>
        <h1 className="text-2xl font-bold">CLI authorized</h1>
        <p className="text-muted-foreground">You can return to your terminal — the CLI is now signed in.</p>
        <a href="/dashboard" className="text-primary hover:underline mt-2">Go to dashboard</a>
      </div>
    );
  }

  if (!code) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3 px-6 text-center">
        <h1 className="text-2xl font-bold">Authorize the CLI</h1>
        <p className="text-muted-foreground">No device code was provided. Re-run <code>kproxy login</code> and open the link it prints.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-5 px-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 flex flex-col items-center gap-5 text-center">
        <h1 className="text-2xl font-bold">Authorize the KProxy CLI</h1>
        <p className="text-muted-foreground">
          A command-line app is requesting access to your account. Confirm this code matches the one shown in your terminal.
        </p>
        <div className="font-mono text-3xl tracking-widest bg-muted rounded-lg px-6 py-3">{code}</div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          onClick={approve}
          disabled={status === 'approving'}
          className="w-full rounded-lg bg-primary text-primary-foreground py-2.5 font-medium hover:opacity-90 disabled:opacity-50"
        >
          {status === 'approving' ? 'Authorizing…' : 'Authorize CLI'}
        </button>
        <p className="text-xs text-muted-foreground">
          Only approve this if you just started a CLI login. It creates an API key scoped to your organization.
        </p>
      </div>
    </div>
  );
}
