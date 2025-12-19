import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, EnhancedTunnel } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/use-toast';
import { 
  Plus, 
  Globe, 
  Copy, 
  ExternalLink, 
  MoreVertical,
  Trash2,
  RefreshCw,
  Search,
  Filter,
  Zap,
  Clock,
  BarChart3,
  Activity,
  Terminal,
  Server,
  Wifi,
  WifiOff,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
  XCircle,
  Pause,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Transform API tunnel data to UI format
interface TunnelUIData {
  id: string;
  name: string;
  subdomain: string;
  domain: string;
  status: 'online' | 'offline' | 'error';
  localPort: number;
  localHost: string;
  protocol: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  connectedAt: number | null;
  lastRequest: number | null;
  agentId: string | null;
  tcpPort?: number; // For TCP tunnels
}

const transformTunnel = (tunnel: EnhancedTunnel): TunnelUIData => ({
  id: tunnel.id,
  name: tunnel.domain,
  subdomain: tunnel.domain,
  domain: tunnel.customDomain 
    ? `${tunnel.domain}.${tunnel.customDomain}`
    : `${tunnel.domain}.jrok.io`,
  status: tunnel.status,
  localPort: 3000, // Default, would come from agent data
  localHost: 'localhost',
  protocol: tunnel.protocol === 'tcp' ? 'tcp' : 'https',
  requests: tunnel.totalRequests,
  bytesIn: tunnel.bytesIn,
  bytesOut: tunnel.bytesOut,
  connectedAt: tunnel.active ? tunnel.createdAt : null,
  lastRequest: tunnel.lastRequestAt || null,
  agentId: tunnel.agentId,
  tcpPort: tunnel.tcpPort,
});

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatDuration = (timestamp: number | null) => {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatRelativeTime = (timestamp: number | null) => {
  if (!timestamp) return 'Never';
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

export default function TunnelsPage() {
  const { currentOrganization } = useAuth();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newTunnelName, setNewTunnelName] = useState('');
  const [newTunnelPort, setNewTunnelPort] = useState('3000');
  const [newTunnelSubdomain, setNewTunnelSubdomain] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');

  // Fetch tunnels from API
  const { data: tunnelsData, isLoading } = useQuery({
    queryKey: ['tunnels', 'enhanced', currentOrganization?.id],
    queryFn: () => api.getEnhancedTunnels(),
    enabled: !!currentOrganization,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const tunnels = tunnelsData?.tunnels?.map(transformTunnel) || [];

  const filteredTunnels = tunnels.filter(tunnel => {
    const matchesSearch = tunnel.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          tunnel.domain.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || tunnel.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const onlineTunnels = tunnels.filter(t => t.status === 'online').length;
  const totalRequests = tunnels.reduce((acc, t) => acc + t.requests, 0);
  const totalBytesIn = tunnels.reduce((acc, t) => acc + t.bytesIn, 0);
  const totalBytesOut = tunnels.reduce((acc, t) => acc + t.bytesOut, 0);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast({
      title: 'Copied!',
      description: 'URL copied to clipboard',
    });
  };

  const handleCreateTunnel = () => {
    toast({
      title: 'Tunnel configuration saved',
      description: 'Use the CLI to start this tunnel: jrok tunnel --port ' + newTunnelPort,
    });
    setIsDialogOpen(false);
    setNewTunnelName('');
    setNewTunnelPort('3000');
    setNewTunnelSubdomain('');
  };

  if (!currentOrganization) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Globe className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-2">No organization selected</h3>
        <p className="text-muted-foreground text-center max-w-sm">
          Select an organization from the sidebar to manage your tunnels.
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
            <Globe className="h-7 w-7 text-primary" />
            Tunnels
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your tunnel connections and expose local services
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 shadow-lg shadow-primary/25">
              <Plus className="h-4 w-4" />
              New Tunnel
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Tunnel</DialogTitle>
              <DialogDescription>
                Configure a new tunnel. You'll need to start it using the CLI.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Tunnel Name</Label>
                <Input
                  id="name"
                  placeholder="my-app"
                  value={newTunnelName}
                  onChange={(e) => setNewTunnelName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subdomain">Subdomain (optional)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="subdomain"
                    placeholder="my-app"
                    value={newTunnelSubdomain}
                    onChange={(e) => setNewTunnelSubdomain(e.target.value)}
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">.jrok.io</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave empty for a random subdomain
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="port">Local Port</Label>
                <Input
                  id="port"
                  type="number"
                  placeholder="3000"
                  value={newTunnelPort}
                  onChange={(e) => setNewTunnelPort(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateTunnel}>
                <Terminal className="h-4 w-4 mr-2" />
                Create Tunnel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card className="bg-gradient-to-br from-emerald-500/10 to-transparent border-emerald-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Online</p>
                <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">{onlineTunnels}</p>
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
                <p className="text-sm text-muted-foreground">Total Requests</p>
                <p className="text-3xl font-bold">{totalRequests.toLocaleString()}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Activity className="h-6 w-6 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Data In</p>
                <p className="text-3xl font-bold flex items-center gap-1">
                  <ArrowDownRight className="h-5 w-5 text-emerald-500" />
                  {formatBytes(totalBytesIn)}
                </p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-purple-500/10 flex items-center justify-center">
                <BarChart3 className="h-6 w-6 text-purple-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Data Out</p>
                <p className="text-3xl font-bold flex items-center gap-1">
                  <ArrowUpRight className="h-5 w-5 text-amber-500" />
                  {formatBytes(totalBytesOut)}
                </p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <BarChart3 className="h-6 w-6 text-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters & Search */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search tunnels..."
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

      {/* Tunnels List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Your Tunnels</CardTitle>
          <CardDescription>
            {filteredTunnels.length} tunnel{filteredTunnels.length !== 1 ? 's' : ''} found
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredTunnels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Globe className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">No tunnels found</h3>
              <p className="text-muted-foreground text-center max-w-sm mb-4">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your filters'
                  : 'Create your first tunnel to start exposing local services'}
              </p>
              {!searchQuery && statusFilter === 'all' && (
                <Button onClick={() => setIsDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Tunnel
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTunnels.map((tunnel) => (
                <div 
                  key={tunnel.id}
                  className={cn(
                    "group relative overflow-hidden rounded-xl border p-4 transition-all hover:shadow-md",
                    tunnel.status === 'online' 
                      ? "bg-gradient-to-r from-emerald-500/5 to-transparent border-emerald-500/20 hover:border-emerald-500/40"
                      : "hover:bg-muted/30"
                  )}
                >
                  {/* Status indicator line */}
                  <div className={cn(
                    "absolute left-0 top-0 bottom-0 w-1",
                    tunnel.status === 'online' ? "bg-emerald-500" : "bg-muted-foreground/30"
                  )} />

                  <div className="flex flex-col lg:flex-row lg:items-center gap-4 pl-3">
                    {/* Main Info */}
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className={cn(
                        "h-12 w-12 rounded-xl flex items-center justify-center shrink-0",
                        tunnel.status === 'online' ? "bg-emerald-500/10" : "bg-muted"
                      )}>
                        {tunnel.status === 'online' ? (
                          <Wifi className="h-6 w-6 text-emerald-500" />
                        ) : (
                          <WifiOff className="h-6 w-6 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold truncate">{tunnel.name}</h3>
                          <Badge variant={tunnel.status === 'online' ? 'success' : 'secondary'} className="text-[10px]">
                            {tunnel.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {tunnel.protocol === 'tcp' ? (
                            <>
                              <Badge variant="outline" className="text-[10px] bg-purple-500/10 text-purple-600 border-purple-500/30">
                                TCP
                              </Badge>
                              <code className="text-sm text-muted-foreground bg-muted/50 px-2 py-0.5 rounded truncate max-w-[250px]">
                                {tunnel.domain}:{tunnel.tcpPort || 'N/A'}
                              </code>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => copyToClipboard(`${tunnel.domain}:${tunnel.tcpPort}`)}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <code className="text-sm text-muted-foreground bg-muted/50 px-2 py-0.5 rounded truncate max-w-[250px]">
                                https://{tunnel.domain}
                              </code>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => copyToClipboard(`https://${tunnel.domain}`)}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                asChild
                              >
                                <a href={`https://${tunnel.domain}`} target="_blank" rel="noopener">
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-6 text-sm pl-16 lg:pl-0">
                      <div className="text-center hidden sm:block">
                        <p className="font-medium">{tunnel.localHost}:{tunnel.localPort}</p>
                        <p className="text-xs text-muted-foreground">Local</p>
                      </div>
                      <div className="text-center">
                        <p className="font-medium">{tunnel.requests.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">Requests</p>
                      </div>
                      <div className="text-center hidden md:block">
                        <p className="font-medium">{formatBytes(tunnel.bytesIn + tunnel.bytesOut)}</p>
                        <p className="text-xs text-muted-foreground">Traffic</p>
                      </div>
                      <div className="text-center hidden lg:block">
                        <p className="font-medium">{tunnel.status === 'online' ? formatDuration(tunnel.connectedAt) : '-'}</p>
                        <p className="text-xs text-muted-foreground">Uptime</p>
                      </div>
                      <div className="text-center hidden lg:block">
                        <p className="font-medium">{formatRelativeTime(tunnel.lastRequest)}</p>
                        <p className="text-xs text-muted-foreground">Last Request</p>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {tunnel.protocol === 'tcp' ? (
                            <>
                              <DropdownMenuItem onClick={() => copyToClipboard(`${tunnel.domain}:${tunnel.tcpPort}`)}>
                                <Copy className="h-4 w-4 mr-2" />
                                Copy TCP Address
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => copyToClipboard(`ssh user@${tunnel.domain} -p ${tunnel.tcpPort}`)}>
                                <Terminal className="h-4 w-4 mr-2" />
                                Copy SSH Command
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem onClick={() => copyToClipboard(`https://${tunnel.domain}`)}>
                                <Copy className="h-4 w-4 mr-2" />
                                Copy URL
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <a href={`https://${tunnel.domain}`} target="_blank" rel="noopener">
                                  <ExternalLink className="h-4 w-4 mr-2" />
                                  Open in Browser
                                </a>
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Reconnect
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive">
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete Tunnel
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* CLI Instructions */}
      <Card className="bg-gradient-to-br from-muted/50 to-transparent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Start a Tunnel via CLI
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0 mt-1">1</div>
              <div className="flex-1">
                <p className="font-medium mb-2">Basic tunnel (random subdomain)</p>
                <div className="relative">
                  <pre className="bg-background/80 border rounded-lg p-3 text-sm font-mono overflow-x-auto">
                    jrok --port 3000
                  </pre>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute top-2 right-2 h-7 w-7"
                    onClick={() => copyToClipboard('jrok --port 3000')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0 mt-1">2</div>
              <div className="flex-1">
                <p className="font-medium mb-2">Custom subdomain</p>
                <div className="relative">
                  <pre className="bg-background/80 border rounded-lg p-3 text-sm font-mono overflow-x-auto">
                    jrok --port 3000 --domain my-app
                  </pre>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute top-2 right-2 h-7 w-7"
                    onClick={() => copyToClipboard('jrok --port 3000 --domain my-app')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-purple-500/10 flex items-center justify-center text-xs font-bold text-purple-600 shrink-0 mt-1">3</div>
              <div className="flex-1">
                <p className="font-medium mb-2">TCP tunnel (SSH, MongoDB, etc.)</p>
                <div className="relative">
                  <pre className="bg-background/80 border rounded-lg p-3 text-sm font-mono overflow-x-auto">
                    jrok --tcp --port 22 --domain my-ssh
                  </pre>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute top-2 right-2 h-7 w-7"
                    onClick={() => copyToClipboard('jrok --tcp --port 22 --domain my-ssh')}
                  >
                    <Copy className="h-3.5 w-3.5" />
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
