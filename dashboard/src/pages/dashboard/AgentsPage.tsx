import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, EnhancedAgent } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/use-toast';
import { 
  Terminal, 
  Search,
  MoreVertical,
  Trash2,
  RefreshCw,
  Wifi,
  WifiOff,
  Clock,
  Activity,
  Cpu,
  HardDrive,
  Globe,
  Server,
  MonitorSmartphone,
  Laptop,
  Smartphone,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Signal,
  SignalHigh,
  SignalLow,
  SignalZero,
  MapPin,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Transform API agent data to UI format
interface AgentUIData {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  status: 'online' | 'offline';
  version: string;
  ip: string;
  publicIp: string;
  location: string;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  tunnelsCount: number;
  cpuUsage: number;
  memoryUsage: number;
}

const transformAgent = (agent: EnhancedAgent): AgentUIData => ({
  id: agent.id,
  name: agent.domain || agent.id.substring(0, 8),
  hostname: agent.localHost || 'localhost',
  platform: agent.platform || 'unknown',
  arch: agent.arch || 'x64',
  status: agent.active ? 'online' : 'offline',
  version: agent.cliVersion || '1.0.0',
  ip: agent.localHost || '127.0.0.1',
  publicIp: agent.clientIp || 'Unknown',
  location: 'Auto-detected',
  connectedAt: agent.active ? agent.connectedAt : null,
  lastHeartbeat: agent.lastHeartbeat,
  tunnelsCount: agent.tunnelCount || 1,
  cpuUsage: agent.cpuUsage || 0,
  memoryUsage: agent.memoryUsage || 0,
});

const formatDuration = (timestamp: number | null) => {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatLastSeen = (timestamp: number | null) => {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
};

const getPlatformIcon = (platform: string) => {
  switch (platform) {
    case 'darwin':
      return Laptop;
    case 'linux':
      return Server;
    case 'win32':
      return MonitorSmartphone;
    default:
      return Terminal;
  }
};

const getPlatformName = (platform: string) => {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
};

const getSignalStrength = (lastHeartbeat: number | null) => {
  if (!lastHeartbeat) return 0;
  const diff = Date.now() - lastHeartbeat;
  if (diff < 30000) return 3; // < 30s = excellent
  if (diff < 60000) return 2; // < 1m = good
  if (diff < 300000) return 1; // < 5m = weak
  return 0; // > 5m = no signal
};

export default function AgentsPage() {
  const { currentOrganization } = useAuth();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');

  // Fetch agents from API
  const { data: agentsData, isLoading, refetch } = useQuery({
    queryKey: ['agents', 'enhanced'],
    queryFn: () => api.getEnhancedAgents(),
    refetchInterval: 10000, // Refresh every 10 seconds for real-time feel
  });

  const agents = agentsData?.agents?.map(transformAgent) || [];

  const filteredAgents = agents.filter(agent => {
    const matchesSearch = agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          agent.hostname.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || agent.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const onlineAgents = agents.filter(a => a.status === 'online').length;
  const totalTunnels = agents.reduce((acc, a) => acc + a.tunnelsCount, 0);
  const avgCpuUsage = Math.round(agents.filter(a => a.status === 'online').reduce((acc, a) => acc + a.cpuUsage, 0) / (onlineAgents || 1));

  if (!currentOrganization) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Terminal className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-2">No organization selected</h3>
        <p className="text-muted-foreground text-center max-w-sm">
          Select an organization from the sidebar to view connected agents.
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
            <Terminal className="h-7 w-7 text-primary" />
            Agents
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor your connected Jrok CLI agents
          </p>
        </div>
        <Button variant="outline" className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card className="bg-gradient-to-br from-emerald-500/10 to-transparent border-emerald-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Online Agents</p>
                <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">{onlineAgents}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <Wifi className="h-6 w-6 text-emerald-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Agents</p>
                <p className="text-3xl font-bold">{agents.length}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Terminal className="h-6 w-6 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Tunnels</p>
                <p className="text-3xl font-bold">{totalTunnels}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-purple-500/10 flex items-center justify-center">
                <Globe className="h-6 w-6 text-purple-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Avg CPU Usage</p>
                <p className="text-3xl font-bold">{avgCpuUsage}%</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Cpu className="h-6 w-6 text-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)} className="w-auto">
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="online" className="gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Online
                </TabsTrigger>
                <TabsTrigger value="offline" className="gap-1">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                  Offline
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* Agents List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Connected Agents</CardTitle>
          <CardDescription>
            {filteredAgents.length} agent{filteredAgents.length !== 1 ? 's' : ''} registered
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Terminal className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">No agents found</h3>
              <p className="text-muted-foreground text-center max-w-sm mb-4">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your filters'
                  : 'Install the Jrok CLI to connect your first agent'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAgents.map((agent) => {
                const PlatformIcon = getPlatformIcon(agent.platform);
                const signalStrength = getSignalStrength(agent.lastHeartbeat);
                
                return (
                  <div 
                    key={agent.id}
                    className={cn(
                      "group relative overflow-hidden rounded-xl border p-4 transition-all hover:shadow-md",
                      agent.status === 'online' 
                        ? "bg-gradient-to-r from-emerald-500/5 to-transparent border-emerald-500/20 hover:border-emerald-500/40"
                        : "hover:bg-muted/30"
                    )}
                  >
                    {/* Status indicator line */}
                    <div className={cn(
                      "absolute left-0 top-0 bottom-0 w-1",
                      agent.status === 'online' ? "bg-emerald-500" : "bg-muted-foreground/30"
                    )} />

                    <div className="flex flex-col lg:flex-row lg:items-center gap-4 pl-3">
                      {/* Agent Info */}
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        <div className={cn(
                          "h-12 w-12 rounded-xl flex items-center justify-center shrink-0",
                          agent.status === 'online' ? "bg-emerald-500/10" : "bg-muted"
                        )}>
                          <PlatformIcon className={cn(
                            "h-6 w-6",
                            agent.status === 'online' ? "text-emerald-500" : "text-muted-foreground"
                          )} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold truncate">{agent.name}</h3>
                            <Badge variant={agent.status === 'online' ? 'success' : 'secondary'} className="text-[10px]">
                              {agent.status}
                            </Badge>
                            {agent.version && (
                              <Badge variant="outline" className="text-[10px]">
                                v{agent.version}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <Server className="h-3 w-3" />
                              {agent.hostname}
                            </span>
                            <span>{getPlatformName(agent.platform)} ({agent.arch})</span>
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {agent.location}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Stats */}
                      {agent.status === 'online' && (
                        <div className="flex items-center gap-6 text-sm pl-16 lg:pl-0">
                          {/* Signal Strength */}
                          <div className="text-center hidden sm:block">
                            <div className="flex items-center justify-center gap-0.5 mb-1">
                              {[1, 2, 3].map((bar) => (
                                <div
                                  key={bar}
                                  className={cn(
                                    "w-1 rounded-full",
                                    bar <= signalStrength ? "bg-emerald-500" : "bg-muted",
                                    bar === 1 ? "h-2" : bar === 2 ? "h-3" : "h-4"
                                  )}
                                />
                              ))}
                            </div>
                            <p className="text-xs text-muted-foreground">Signal</p>
                          </div>

                          <div className="text-center">
                            <p className="font-medium flex items-center gap-1">
                              <Cpu className="h-3 w-3 text-muted-foreground" />
                              {agent.cpuUsage}%
                            </p>
                            <p className="text-xs text-muted-foreground">CPU</p>
                          </div>
                          
                          <div className="text-center">
                            <p className="font-medium flex items-center gap-1">
                              <HardDrive className="h-3 w-3 text-muted-foreground" />
                              {agent.memoryUsage}%
                            </p>
                            <p className="text-xs text-muted-foreground">Memory</p>
                          </div>

                          <div className="text-center">
                            <p className="font-medium">{agent.tunnelsCount}</p>
                            <p className="text-xs text-muted-foreground">Tunnels</p>
                          </div>

                          <div className="text-center hidden lg:block">
                            <p className="font-medium">{formatDuration(agent.connectedAt)}</p>
                            <p className="text-xs text-muted-foreground">Uptime</p>
                          </div>
                        </div>
                      )}

                      {agent.status === 'offline' && (
                        <div className="flex items-center gap-4 text-sm pl-16 lg:pl-0">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Clock className="h-4 w-4" />
                            Last seen: {formatLastSeen(agent.lastHeartbeat)}
                          </div>
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pl-16 lg:pl-0">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>
                              <Activity className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                              <Globe className="h-4 w-4 mr-2" />
                              View Tunnels
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem>
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Restart Agent
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive">
                              <Trash2 className="h-4 w-4 mr-2" />
                              Disconnect
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* CLI Installation Guide */}
      <Card className="bg-gradient-to-br from-muted/50 to-transparent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Connect a New Agent
          </CardTitle>
          <CardDescription>
            Install the Jrok CLI on your machine to connect it as an agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="p-4 rounded-xl border bg-card">
              <p className="font-medium mb-3">Install via npm</p>
              <pre className="bg-muted/50 p-3 rounded-lg text-sm font-mono overflow-x-auto">
                npm install -g @jrok/cli
              </pre>
            </div>
            <div className="p-4 rounded-xl border bg-card">
              <p className="font-medium mb-3">Authenticate and connect</p>
              <pre className="bg-muted/50 p-3 rounded-lg text-sm font-mono overflow-x-auto">
                jrok auth login{'\n'}jrok tunnel --port 3000
              </pre>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
