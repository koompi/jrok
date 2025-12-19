import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, SecurityStats, BlockedIp, ConnectionLog, BandwidthLimit } from '@/lib/api';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/use-toast';
import { 
  Shield, 
  ShieldAlert, 
  ShieldCheck,
  Ban,
  Unlock,
  Activity,
  Server,
  Globe,
  Wifi,
  BarChart3,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format timestamp
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export function SecurityPage() {
  const { user, currentOrganization: currentOrg } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [blockIpDialog, setBlockIpDialog] = useState(false);
  const [newBlockIp, setNewBlockIp] = useState('');
  const [newBlockReason, setNewBlockReason] = useState('');
  const [newBlockDuration, setNewBlockDuration] = useState('3600');

  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin';

  // Fetch security stats
  const { data: statsData, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['security-stats'],
    queryFn: () => api.getSecurityStats(),
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Fetch blocked IPs (admin only)
  const { data: blockedData, isLoading: blockedLoading } = useQuery({
    queryKey: ['blocked-ips'],
    queryFn: () => api.getBlockedIps(),
    enabled: isAdmin,
  });

  // Fetch bandwidth usage for current org
  const { data: bandwidthData, isLoading: bandwidthLoading } = useQuery({
    queryKey: ['bandwidth', currentOrg?.id],
    queryFn: () => currentOrg ? api.getOrganizationBandwidth(currentOrg.id) : Promise.resolve(null),
    enabled: !!currentOrg,
  });

  // Block IP mutation
  const blockIpMutation = useMutation({
    mutationFn: ({ ip, reason, duration }: { ip: string; reason: string; duration?: number }) =>
      api.blockIp(ip, reason, duration),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-ips'] });
      queryClient.invalidateQueries({ queryKey: ['security-stats'] });
      setBlockIpDialog(false);
      setNewBlockIp('');
      setNewBlockReason('');
      toast({
        title: 'IP Blocked',
        description: `Successfully blocked IP address`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Unblock IP mutation
  const unblockIpMutation = useMutation({
    mutationFn: (ip: string) => api.unblockIp(ip),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-ips'] });
      queryClient.invalidateQueries({ queryKey: ['security-stats'] });
      toast({
        title: 'IP Unblocked',
        description: 'Successfully unblocked IP address',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleBlockIp = () => {
    if (!newBlockIp || !newBlockReason) {
      toast({
        title: 'Error',
        description: 'Please enter both IP and reason',
        variant: 'destructive',
      });
      return;
    }
    blockIpMutation.mutate({
      ip: newBlockIp,
      reason: newBlockReason,
      duration: parseInt(newBlockDuration) || 3600,
    });
  };

  const stats = statsData as SecurityStats | undefined;
  const blockedIps = blockedData?.blockedIps || [];
  const bandwidth = bandwidthData as BandwidthLimit | null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-8 w-8" />
            Security
          </h1>
          <p className="text-muted-foreground">
            Monitor security, rate limits, and connection logs
          </p>
        </div>
        <Button onClick={() => refetchStats()} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">HTTP Connections</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{stats?.http?.activeConnections || 0}</div>
                <p className="text-xs text-muted-foreground">Active connections</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">TCP Connections</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{stats?.tcp?.activeConnections || 0}</div>
                <p className="text-xs text-muted-foreground">Active TCP tunnels</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Blocked IPs</CardTitle>
            <Ban className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold text-destructive">{stats?.blockedIps || 0}</div>
                <p className="text-xs text-muted-foreground">Currently blocked</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Logs Buffered</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{stats?.logsBuffered || 0}</div>
                <p className="text-xs text-muted-foreground">Pending flush</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bandwidth Usage */}
      {bandwidth && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Monthly Bandwidth Usage
            </CardTitle>
            <CardDescription>
              Your organization's bandwidth consumption this month
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span>{formatBytes(bandwidth.usedBytes)} used</span>
              <span>
                {bandwidth.limitBytes === -1 
                  ? 'Unlimited' 
                  : `${formatBytes(bandwidth.limitBytes)} limit`}
              </span>
            </div>
            {bandwidth.limitBytes !== -1 && (
              <>
                <Progress 
                  value={bandwidth.percentUsed} 
                  className={cn(
                    bandwidth.percentUsed > 90 ? 'bg-destructive/20' : 
                    bandwidth.percentUsed > 75 ? 'bg-yellow-500/20' : ''
                  )}
                />
                <div className="flex items-center gap-2 text-sm">
                  {bandwidth.percentUsed > 90 ? (
                    <>
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                      <span className="text-destructive">
                        {bandwidth.percentUsed.toFixed(1)}% used - Consider upgrading your plan
                      </span>
                    </>
                  ) : bandwidth.percentUsed > 75 ? (
                    <>
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      <span className="text-yellow-500">
                        {bandwidth.percentUsed.toFixed(1)}% used
                      </span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span className="text-muted-foreground">
                        {bandwidth.percentUsed.toFixed(1)}% used
                      </span>
                    </>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Admin Section - Blocked IPs */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5" />
                  Blocked IPs
                </CardTitle>
                <CardDescription>
                  Manage blocked IP addresses (admin only)
                </CardDescription>
              </div>
              <Dialog open={blockIpDialog} onOpenChange={setBlockIpDialog}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    Block IP
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Block IP Address</DialogTitle>
                    <DialogDescription>
                      Block an IP address from accessing all tunnels
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="ip">IP Address</Label>
                      <Input
                        id="ip"
                        placeholder="192.168.1.1"
                        value={newBlockIp}
                        onChange={(e) => setNewBlockIp(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reason">Reason</Label>
                      <Input
                        id="reason"
                        placeholder="Abuse, DDoS, etc."
                        value={newBlockReason}
                        onChange={(e) => setNewBlockReason(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="duration">Duration (seconds)</Label>
                      <Input
                        id="duration"
                        type="number"
                        placeholder="3600"
                        value={newBlockDuration}
                        onChange={(e) => setNewBlockDuration(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: 3600 (1 hour). Set to 0 for permanent block.
                      </p>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setBlockIpDialog(false)}>
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleBlockIp}
                      disabled={blockIpMutation.isPending}
                    >
                      {blockIpMutation.isPending ? 'Blocking...' : 'Block IP'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {blockedLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : blockedIps.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <ShieldCheck className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No blocked IPs</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>IP Address</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Blocked At</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {blockedIps.map((blocked) => (
                    <TableRow key={blocked.ip}>
                      <TableCell className="font-mono">{blocked.ip}</TableCell>
                      <TableCell>{blocked.reason}</TableCell>
                      <TableCell>{formatRelativeTime(blocked.blockedAt)}</TableCell>
                      <TableCell>
                        {blocked.expiresAt === 0 
                          ? <Badge variant="destructive">Permanent</Badge>
                          : formatRelativeTime(blocked.expiresAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => unblockIpMutation.mutate(blocked.ip)}
                          disabled={unblockIpMutation.isPending}
                        >
                          <Unlock className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Rate Limits Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Rate Limits
          </CardTitle>
          <CardDescription>
            Current rate limits for your plan
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <h4 className="font-semibold">HTTP Limits</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Requests per minute</span>
                  <span>60 × plan multiplier</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Requests per hour</span>
                  <span>1,000 × plan multiplier</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Concurrent connections</span>
                  <span>100 × plan multiplier</span>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="font-semibold">TCP Limits</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Connections per tunnel</span>
                  <span>10 × plan multiplier</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Connections per org</span>
                  <span>50 × plan multiplier</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bandwidth per minute</span>
                  <span>10 MB × plan multiplier</span>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              Plan multipliers: Free (1x), Starter (5x), Pro (20x), Enterprise (100x)
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SecurityPage;
