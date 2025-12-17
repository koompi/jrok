import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ActivityLog, ActivityCategory } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Activity, 
  Search,
  Filter,
  Globe,
  Key,
  Terminal,
  Shield,
  Users,
  Building2,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Download,
  RefreshCw,
  Calendar,
  Radio,
  UserPlus,
  UserMinus,
  Settings,
  Trash2,
  Plus,
  ArrowRight,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Transform API activity data to UI format
interface ActivityUIData {
  id: string;
  type: string;
  category: ActivityCategory;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  user: { name: string; email: string };
  timestamp: number;
  status: 'success' | 'warning' | 'error';
}

const getActivityTitle = (action: string, resourceType: string): string => {
  const titles: Record<string, string> = {
    'tunnel:created': 'Tunnel Created',
    'tunnel:deleted': 'Tunnel Deleted',
    'domain:created': 'Domain Added',
    'domain:verified': 'Domain Verified',
    'domain:renewed': 'SSL Certificate Renewed',
    'api_key:created': 'API Key Generated',
    'api_key:deleted': 'API Key Revoked',
    'agent:connected': 'Agent Connected',
    'agent:disconnected': 'Agent Disconnected',
    'organization:created': 'Organization Created',
    'auth:login': 'User Logged In',
  };
  return titles[`${resourceType}:${action}`] || `${resourceType} ${action}`;
};

const getActivityStatus = (action: string): 'success' | 'warning' | 'error' => {
  if (['deleted', 'revoked', 'failed'].includes(action)) return 'warning';
  if (['disconnected', 'expired'].includes(action)) return 'error';
  return 'success';
};

const transformActivity = (activity: ActivityLog): ActivityUIData => ({
  id: activity.id,
  type: `${activity.resourceType}_${activity.action}`,
  category: activity.category,
  title: getActivityTitle(activity.action, activity.resourceType),
  description: activity.description,
  metadata: activity.metadata || {},
  user: { name: activity.userId || 'System', email: activity.ipAddress || 'system@jrok.io' },
  timestamp: activity.createdAt,
  status: getActivityStatus(activity.action),
});

const getActivityIcon = (type: string) => {
  const iconMap: Record<string, React.ElementType> = {
    tunnel_created: Globe,
    tunnel_deleted: Globe,
    api_key_created: Key,
    api_key_revoked: Key,
    ssl_renewed: Shield,
    agent_connected: Terminal,
    agent_disconnected: Terminal,
    member_invited: UserPlus,
    member_removed: UserMinus,
    domain_added: Radio,
    domain_removed: Radio,
    plan_upgraded: Building2,
    settings_updated: Settings,
  };
  return iconMap[type] || Activity;
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'success':
      return 'text-emerald-500 bg-emerald-500/10';
    case 'warning':
      return 'text-amber-500 bg-amber-500/10';
    case 'error':
      return 'text-destructive bg-destructive/10';
    default:
      return 'text-muted-foreground bg-muted';
  }
};

const formatTimestamp = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
};

const formatFullDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function ActivityPage() {
  const { currentOrganization } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // Fetch activities from API
  const { data: activityData, isLoading, refetch } = useQuery({
    queryKey: ['activity', currentOrganization?.id, categoryFilter],
    queryFn: () => api.getActivity({
      category: categoryFilter !== 'all' ? categoryFilter as ActivityCategory : undefined,
      limit: 100,
    }),
    enabled: !!currentOrganization,
    refetchInterval: 60000, // Refresh every minute
  });

  const activities = activityData?.activities?.map(transformActivity) || [];

  const filteredActivities = activities.filter(activity => {
    const matchesSearch = activity.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          activity.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  const categoryStats = {
    all: activityData?.total || 0,
    tunnels: activities.filter(a => a.category === 'tunnels').length,
    domains: activities.filter(a => a.category === 'domains').length,
    api_keys: activities.filter(a => a.category === 'api_keys').length,
    agents: activities.filter(a => a.category === 'agents').length,
    organization: activities.filter(a => a.category === 'organization').length,
  };

  if (!currentOrganization) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Activity className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-2">No organization selected</h3>
        <p className="text-muted-foreground text-center max-w-sm">
          Select an organization from the sidebar to view activity logs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold flex items-center gap-2">
            <Activity className="h-7 w-7 text-primary" />
            Activity Log
          </h1>
          <p className="text-muted-foreground mt-1">
            Track all actions and events in your workspace
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search activities..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Tabs value={categoryFilter} onValueChange={setCategoryFilter} className="w-auto">
              <TabsList className="flex-wrap h-auto gap-1 p-1">
                <TabsTrigger value="all" className="gap-1">
                  All
                  <Badge variant="secondary" className="ml-1 text-[10px] h-5 px-1.5">{categoryStats.all}</Badge>
                </TabsTrigger>
                <TabsTrigger value="tunnels" className="gap-1">
                  <Globe className="h-3 w-3" />
                  Tunnels
                </TabsTrigger>
                <TabsTrigger value="domains" className="gap-1">
                  <Radio className="h-3 w-3" />
                  Domains
                </TabsTrigger>
                <TabsTrigger value="api_keys" className="gap-1">
                  <Key className="h-3 w-3" />
                  API Keys
                </TabsTrigger>
                <TabsTrigger value="agents" className="gap-1">
                  <Terminal className="h-3 w-3" />
                  Agents
                </TabsTrigger>
                <TabsTrigger value="organization" className="gap-1">
                  <Building2 className="h-3 w-3" />
                  Org
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* Activity List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Activity</CardTitle>
          <CardDescription>
            {filteredActivities.length} event{filteredActivities.length !== 1 ? 's' : ''} found
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredActivities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Activity className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">No activity found</h3>
              <p className="text-muted-foreground text-center max-w-sm">
                {searchQuery || categoryFilter !== 'all' 
                  ? 'Try adjusting your filters'
                  : 'Activity will appear here as you use Jrok'}
              </p>
            </div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[23px] top-0 bottom-0 w-px bg-border" />
              
              <div className="space-y-1">
                {filteredActivities.map((activity, index) => {
                  const Icon = getActivityIcon(activity.type);
                  const statusColor = getStatusColor(activity.status);
                  
                  // Group by date
                  const currentDate = new Date(activity.timestamp).toDateString();
                  const prevDate = index > 0 ? new Date(filteredActivities[index - 1].timestamp).toDateString() : null;
                  const showDateHeader = currentDate !== prevDate;
                  
                  return (
                    <div key={activity.id}>
                      {showDateHeader && (
                        <div className="flex items-center gap-3 py-4 pl-12">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium text-muted-foreground">
                            {new Date(activity.timestamp).toLocaleDateString('en-US', {
                              weekday: 'long',
                              month: 'long',
                              day: 'numeric',
                            })}
                          </span>
                        </div>
                      )}
                      
                      <div className="group relative flex gap-4 py-3 pl-2 pr-4 rounded-lg hover:bg-muted/50 transition-colors">
                        {/* Icon */}
                        <div className={cn(
                          "relative z-10 h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
                          statusColor
                        )}>
                          <Icon className="h-5 w-5" />
                        </div>
                        
                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h4 className="font-medium text-sm">{activity.title}</h4>
                              <p className="text-sm text-muted-foreground mt-0.5">
                                {activity.description}
                              </p>
                              <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {activity.user.name}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {formatTimestamp(activity.timestamp)}
                                </span>
                              </div>
                            </div>
                            
                            {/* Actions */}
                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <Eye className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity Summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Successful Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {activities.filter(a => a.status === 'success').length}
            </p>
            <p className="text-xs text-muted-foreground mt-1">in the last 7 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {activities.filter(a => a.status === 'warning').length}
            </p>
            <p className="text-xs text-muted-foreground mt-1">require attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <XCircle className="h-4 w-4 text-destructive" />
              Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">
              {activities.filter(a => a.status === 'error').length}
            </p>
            <p className="text-xs text-muted-foreground mt-1">in the last 7 days</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
