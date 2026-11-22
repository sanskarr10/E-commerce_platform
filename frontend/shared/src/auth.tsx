import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from './api';
import { createEndpoints, type Endpoints } from './endpoints';
import type { User } from './types';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: AuthStatus;
  user: User | null;
  api: ApiClient;
  endpoints: Endpoints;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string, fullName: string) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const endpoints = useMemo(() => createEndpoints(api), [api]);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Page load: the access token is gone (memory only), but the refresh cookie may still be valid.
    (async () => {
      const token = await api.refresh();
      if (!token) return cancelled || setStatus('anonymous');
      try {
        const me = await endpoints.users.me();
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();
    const stop = api.onSessionLost(() => {
      setUser(null);
      setStatus('anonymous');
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [api, endpoints]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { access_token } = await endpoints.users.login(email, password);
      api.setToken(access_token);
      const me = await endpoints.users.me();
      setUser(me);
      setStatus('authenticated');
      return me;
    },
    [api, endpoints],
  );

  const register = useCallback(
    async (email: string, password: string, fullName: string) => {
      await endpoints.users.register(email, password, fullName);
      return login(email, password);
    },
    [endpoints, login],
  );

  const logout = useCallback(async () => {
    try {
      await endpoints.users.logout();
    } catch {
      // the local session is cleared either way
    }
    api.setToken(null);
    setUser(null);
    setStatus('anonymous');
  }, [api, endpoints]);

  const value = useMemo(
    () => ({ status, user, api, endpoints, login, register, logout }),
    [status, user, api, endpoints, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
