import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { api, DashboardStats, ActivityLog } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Key, 
  Building2, 
  Globe, 
  Activity, 
  AlertTriangle,
  Plus,
  ArrowRight,
  Terminal,
  Zap,
  TrendingUp,
  Clock,
  Copy,
  ExternalLink,
  CheckCircle2,
  Radio,
  Shield,
  BarChart3,
  Sparkles,
  Play,
  BookOpen,
  Wifi,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

// Format time helper
const formatTimeAgo = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
};

// Get icon for activity type
const getActivityIcon = (category: string) => {
  switch (category) {
    case 'tunnels': return Globe;
    case 'domains': return Shield;
    case 'api_keys': return Key;
    case 'agents': return Terminal;
    default: return Activity;
  }
};

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

  // Fetch dashboard stats
  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['stats', 'dashboard', currentOrganization?.id],
    queryFn: () => api.getDashboardStats(),
    enabled: !!currentOrganization,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Fetch recent activity
  const { data: activityData } = useQuery({
    queryKey: ['activity', 'recent', currentOrganization?.id],
    queryFn: () => api.getRecentActivity(5),
    enabled: !!currentOrganization,
  });

  // Fetch tunnels for quick view
  const { data: tunnelsData } = useQuery({
    queryKey: ['tunnels', 'enhanced', currentOrganization?.id],
    queryFn: () => api.getEnhancedTunnels(),
    enabled: !!currentOrganization,
  });

  const organization = orgData?.organization;
  const subscription = organization?.subscription;
  const stats = statsData?.stats;
  const recentActivity = activityData?.activities || [];
  const recentTunnels = tunnelsData?.tunnels?.slice(0, 3) || [];

  // Calculate usage percentages from real data
  const tunnelUsage = stats ? Math.round((stats.plan.usedTunnels / stats.plan.tunnelLimit) * 100) : 0;
  const bandwidthUsage = stats ? Math.round((stats.plan.usedBandwidth / stats.plan.bandwidthLimit) * 100) : 0;
  const domainUsage = stats ? Math.round((stats.plan.usedDomains / stats.plan.domainLimit) * 100) : 0;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-8">
      {/* Hero Welcome Section */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-background border p-6 lg:p-8">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="relative">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl lg:text-3xl font-bold">
                  Welcome back, {user?.fullname?.split(' ')[0]}! 
                </h1>
                <Sparkles className="h-6 w-6 text-primary animate-pulse" />
              </div>
              <p className="text-muted-foreground max-w-xl">
                Your tunnel infrastructure is running smoothly. Here's what's happening with your services today.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="gap-2 shadow-lg shadow-primary/25">
                <Link to="/dashboard/tunnels">
                  <Plus className="h-4 w-4" />
                  New Tunnel
                </Link>
              </Button>
              <Button variant="outline" asChild className="gap-2">
                <Link to="/dashboard/api-keys">
                  <Key className="h-4 w-4" />
                  API Keys
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {user?.status === 'pending' && (
        <Alert className="bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="font-semibold">Account Pending Approval</AlertTitle>
          <AlertDescription>
            Your account is currently in the waiting list. You will be able to create organizations and use the platform once an administrator approves your account.
          </AlertDescription>
        </Alert>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="group hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Tunnels</CardTitle>
            <div className="h-9 w-9 rounded-xl bg-emerald-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Globe className="h-5 w-5 text-emerald-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{stats?.tunnels.online || 0}</span>
              {stats && stats.tunnels.online > 0 && (
                <Badge variant="success" className="text-[10px]">
                  <Wifi className="h-3 w-3 mr-1" />
                  online
                </Badge>
              )}
            </div>
            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">of {stats?.plan.tunnelLimit || 3} tunnels</span>
                <span className="font-medium">{tunnelUsage}%</span>
              </div>
              <Progress value={tunnelUsage} className="h-1.5" />
            </div>
          </CardContent>
        </Card>

        <Card className="group hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Custom Domains</CardTitle>
            <div className="h-9 w-9 rounded-xl bg-blue-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Radio className="h-5 w-5 text-blue-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{stats?.domains.total || 0}</span>
              <span className="text-xs text-muted-foreground">{stats?.domains.sslValid || 0} SSL active</span>
            </div>
            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">of {stats?.plan.domainLimit || 1} domains</span>
                <span className="font-medium">{domainUsage}%</span>
              </div>
              <Progress value={domainUsage} className="h-1.5" />
            </div>
          </CardContent>
        </Card>

        <Card className="group hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bandwidth Used</CardTitle>
            <div className="h-9 w-9 rounded-xl bg-purple-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <BarChart3 className="h-5 w-5 text-purple-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{stats?.plan.usedBandwidth?.toFixed(1) || '0'}</span>
              <span className="text-sm text-muted-foreground">GB</span>
            </div>
            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">of {stats?.plan.bandwidthLimit || 1} GB</span>
                <span className="font-medium">{bandwidthUsage}%</span>
              </div>
              <Progress value={bandwidthUsage} className="h-1.5" />
            </div>
          </CardContent>
        </Card>

        <Card className="group hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">API Keys</CardTitle>
            <div className="h-9 w-9 rounded-xl bg-amber-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Key className="h-5 w-5 text-amber-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{apiKeysData?.apiKeys?.length || 0}</span>
              <span className="text-xs text-muted-foreground">active</span>
            </div>
            <div className="mt-3">
              <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs -ml-2">
                <Link to="/dashboard/api-keys">
                  Manage keys <ArrowRight className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Active Tunnels - Takes 2 columns */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                Active Tunnels
              </CardTitle>
              <CardDescription>Your currently running tunnel connections</CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to="/dashboard/tunnels">
                View All <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentTunnels.length > 0 ? recentTunnels.map((tunnel) => (
                <div 
                  key={tunnel.id}
                  className="group flex items-center justify-between p-4 rounded-xl border bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "h-10 w-10 rounded-lg flex items-center justify-center",
                      tunnel.status === 'online' ? 'bg-emerald-500/10' : 'bg-muted'
                    )}>
                      <Globe className={cn(
                        "h-5 w-5",
                        tunnel.status === 'online' ? 'text-emerald-500' : 'text-muted-foreground'
                      )} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{tunnel.domain}</span>
                        <Badge variant={tunnel.status === 'online' ? 'success' : 'secondary'} className="text-[10px]">
                          {tunnel.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>{tunnel.customDomain ? `${tunnel.domain}.${tunnel.customDomain}` : `${tunnel.domain}.jrok.io`}</span>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => copyToClipboard(`https://${tunnel.customDomain ? `${tunnel.domain}.${tunnel.customDomain}` : `${tunnel.domain}.jrok.io`}`)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right hidden sm:block">
                      <div className="text-sm font-medium">{tunnel.totalRequests.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">requests</div>
                    </div>
                    <div className="text-right hidden sm:block">
                      <div className="text-sm font-medium">{(tunnel.bytesIn / 1024 / 1024).toFixed(1)} MB</div>
                      <div className="text-xs text-muted-foreground">traffic</div>
                    </div>
                    <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No active tunnels yet</p>
                  <p className="text-sm mt-1">Run <code className="bg-muted px-1.5 py-0.5 rounded">jrok --port 3000</code> to get started</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Recent Activity
            </CardTitle>
            <CardDescription>Latest events in your workspace</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentActivity.length > 0 ? recentActivity.map((activity, index) => {
                const ActivityIcon = getActivityIcon(activity.category);
                return (
                  <div key={activity.id} className="flex gap-3">
                    <div className="relative">
                      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                        <ActivityIcon className="h-4 w-4 text-muted-foreground" />
                      </div>
                      {index !== recentActivity.length - 1 && (
                        <div className="absolute top-8 left-1/2 -translate-x-1/2 w-px h-6 bg-border" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-sm">{activity.description}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        {formatTimeAgo(activity.createdAt)}
                      </p>
                    </div>
                  </div>
                );
              }) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Activity className="h-6 w-6 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No recent activity</p>
                </div>
              )}
            </div>
            <Separator className="my-4" />
            <Button variant="ghost" className="w-full" asChild>
              <Link to="/dashboard/activity">
                View all activity <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Current Plan Card */}
      {subscription && (
        <Card className="overflow-hidden">
          <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-6">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="default" className="text-sm px-3 py-1">
                    {subscription.plan.name}
                  </Badge>
                  <Badge variant="success" className="text-xs">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {subscription.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {subscription.currentPeriodEnd && (
                    <>Renews on {new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>
                  )}
                </p>
              </div>
              <Button variant="outline" className="gap-2">
                <Sparkles className="h-4 w-4" />
                Upgrade Plan
              </Button>
            </div>
          </div>
          <CardContent className="pt-6">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Bandwidth</div>
                <div className="text-2xl font-bold">
                  {subscription.plan.limits.maxBandwidthGb === -1 ? 'Unlimited' : `${subscription.plan.limits.maxBandwidthGb} GB`}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Tunnels</div>
                <div className="text-2xl font-bold">
                  {subscription.plan.limits.maxTunnels === -1 ? 'Unlimited' : subscription.plan.limits.maxTunnels}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">SSL Certificates</div>
                <div className="text-2xl font-bold flex items-center gap-2">
                  {subscription.plan.limits.sslIncluded ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      Included
                    </>
                  ) : 'Not included'}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Custom Domains</div>
                <div className="text-2xl font-bold flex items-center gap-2">
                  {subscription.plan.limits.customDomains ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      Enabled
                    </>
                  ) : 'Disabled'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Start Guide */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            Quick Start Guide
          </CardTitle>
          <CardDescription>
            Get your first tunnel running in under 2 minutes
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="relative group">
              <div className="absolute -inset-px bg-gradient-to-r from-primary/50 to-primary/0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity blur-sm" />
              <div className="relative p-5 rounded-xl border bg-card h-full">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold">
                    1
                  </div>
                  <h4 className="font-semibold">Create an API Key</h4>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  Generate an API key for secure authentication with the CLI.
                </p>
                <Button variant="outline" size="sm" asChild className="w-full">
                  <Link to="/dashboard/api-keys">
                    <Key className="h-4 w-4 mr-2" />
                    Create Key
                  </Link>
                </Button>
              </div>
            </div>

            <div className="relative group">
              <div className="absolute -inset-px bg-gradient-to-r from-primary/50 to-primary/0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity blur-sm" />
              <div className="relative p-5 rounded-xl border bg-card h-full">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold">
                    2
                  </div>
                  <h4 className="font-semibold">Install the CLI</h4>
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  Install Jrok CLI globally using npm or bun.
                </p>
                <div className="relative">
                  <pre className="bg-muted/50 p-3 rounded-lg text-xs font-mono overflow-x-auto">
                    curl -fsSL https://raw.githubusercontent.com/koompi/jrok/v2.4.0/install.sh | bash
                  </pre>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute top-2 right-2 h-6 w-6"
                    onClick={() => copyToClipboard('curl -fsSL https://raw.githubusercontent.com/koompi/jrok/v2.4.0/install.sh | bash')}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="relative group">
              <div className="absolute -inset-px bg-gradient-to-r from-primary/50 to-primary/0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity blur-sm" />
              <div className="relative p-5 rounded-xl border bg-card h-full">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold">
                    3
                  </div>
                  <h4 className="font-semibold">Start Your Tunnel</h4>
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  Expose your local server to the internet.
                </p>
                <div className="relative">
                  <pre className="bg-muted/50 p-3 rounded-lg text-xs font-mono overflow-x-auto">
                    jrok --port 3000
                  </pre>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute top-2 right-2 h-6 w-6"
                    onClick={() => copyToClipboard('jrok --port 3000')}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
