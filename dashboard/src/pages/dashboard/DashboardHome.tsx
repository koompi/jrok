import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Key, Building2, Globe, Activity, AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function DashboardHome() {
  const { user, currentOrganization } = useAuth();

  const { data: orgData } = useQuery({
    queryKey: ['organization', currentOrganization?.id],
    queryFn: () => currentOrganization ? api.getOrganization(currentOrganization.id) : null,
    enabled: !!currentOrganization,
  });

  const { data: apiKeysData } = useQuery({
    queryKey: ['apiKeys', currentOrganization?.id],
    queryFn: () => currentOrganization ? api.getApiKeys(currentOrganization.id) : null,
    enabled: !!currentOrganization,
  });

  const organization = orgData?.organization;
  const subscription = organization?.subscription;

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div>
        <h1 className="text-3xl font-bold">Welcome back, {user?.fullname?.split(' ')[0]}!</h1>
        <p className="text-muted-foreground">
          Here's an overview of your tunnel infrastructure.
        </p>
      </div>

      {user?.status === 'pending' && (
        <Alert variant="destructive" className="bg-yellow-100 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-900 dark:text-yellow-200">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Account Pending Approval</AlertTitle>
          <AlertDescription>
            Your account is currently in the waiting list. You will be able to create organizations and use the platform once an administrator approves your account.
          </AlertDescription>
        </Alert>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Tunnels</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0</div>
            <p className="text-xs text-muted-foreground">
              of {subscription?.plan.limits.maxTunnels === -1 ? '∞' : subscription?.plan.limits.maxTunnels || 0} available
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Custom Domains</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0</div>
            <p className="text-xs text-muted-foreground">
              of {subscription?.plan.limits.maxDomains === -1 ? '∞' : subscription?.plan.limits.maxDomains || 0} available
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
            <Key className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{apiKeysData?.apiKeys?.length || 0}</div>
            <p className="text-xs text-muted-foreground">
              of {subscription?.plan.limits.maxApiKeys === -1 ? '∞' : subscription?.plan.limits.maxApiKeys || 0} available
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Team Members</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{organization?.members?.length || 0}</div>
            <p className="text-xs text-muted-foreground">
              of {subscription?.plan.limits.maxMembers === -1 ? '∞' : subscription?.plan.limits.maxMembers || 0} available
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Current Plan */}
      {subscription && (
        <Card>
          <CardHeader>
            <CardTitle>Current Plan: {subscription.plan.name}</CardTitle>
            <CardDescription>
              Your subscription is {subscription.status}. 
              {subscription.currentPeriodEnd && (
                <> Renews on {new Date(subscription.currentPeriodEnd).toLocaleDateString()}</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="text-sm font-medium">Bandwidth</div>
                <div className="text-2xl font-bold">
                  {subscription.plan.limits.maxBandwidthGb === -1 ? 'Unlimited' : `${subscription.plan.limits.maxBandwidthGb} GB`}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium">SSL Certificates</div>
                <div className="text-2xl font-bold">
                  {subscription.plan.limits.sslIncluded ? 'Included' : 'Not included'}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium">Custom Domains</div>
                <div className="text-2xl font-bold">
                  {subscription.plan.limits.customDomains ? 'Enabled' : 'Disabled'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Start */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Start</CardTitle>
          <CardDescription>
            Get started with Jrok in minutes
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium">1. Create an API Key</h4>
            <p className="text-sm text-muted-foreground">
              Go to API Keys and create a new key for your application.
            </p>
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">2. Install the CLI</h4>
            <pre className="bg-muted p-3 rounded-md text-sm">
              npm install -g @jrok/cli
            </pre>
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">3. Start a Tunnel</h4>
            <pre className="bg-muted p-3 rounded-md text-sm">
              jrok tunnel --port 3000 --domain myapp
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
