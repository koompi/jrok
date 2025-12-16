import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, User, Organization } from '@/lib/api';

interface AuthContextType {
  user: User | null;
  organizations: Organization[];
  isLoading: boolean;
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setCurrentOrganization: (org: Organization | null) => void;
  currentOrganization: Organization | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrganization, setCurrentOrganization] = useState<Organization | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const token = api.getToken();
      if (!token) {
        setUser(null);
        setOrganizations([]);
        return;
      }

      const data = await api.getCurrentUser();
      setUser(data.user);
      setOrganizations(data.organizations);

      // Set default organization
      if (data.organizations.length > 0 && !currentOrganization) {
        const savedOrgId = localStorage.getItem('current_org');
        const org = savedOrgId 
          ? data.organizations.find(o => o.id === savedOrgId) 
          : data.organizations[0];
        setCurrentOrganization(org || data.organizations[0]);
      }
    } catch (error) {
      console.error('Failed to refresh user:', error);
      api.setToken(null);
      setUser(null);
      setOrganizations([]);
    }
  };

  useEffect(() => {
    const init = async () => {
      await refreshUser();
      setIsLoading(false);
    };
    init();
  }, []);

  const login = async () => {
    const { loginUrl } = await api.getLoginUrl();
    window.location.href = loginUrl;
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch (error) {
      console.error('Logout error:', error);
    }
    api.setToken(null);
    setUser(null);
    setOrganizations([]);
    setCurrentOrganization(null);
    localStorage.removeItem('current_org');
  };

  const handleSetCurrentOrganization = (org: Organization | null) => {
    setCurrentOrganization(org);
    if (org) {
      localStorage.setItem('current_org', org.id);
    } else {
      localStorage.removeItem('current_org');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        organizations,
        isLoading,
        isAuthenticated: !!user,
        isSuperAdmin: user?.role === 'super_admin',
        login,
        logout,
        refreshUser,
        currentOrganization,
        setCurrentOrganization: handleSetCurrentOrganization,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
