import { useState, useEffect, useCallback } from 'react';
import { 
  api, 
  MonitoringDashboardData, 
  SystemHealth, 
  SystemLog, 
  RateLimitStats,
  AuthMetrics,
  SystemMetricsSnapshot,
  SystemConfig,
  MonitoringConfig
} from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { 
  Loader2, 
  RefreshCw, 
  Activity, 
  Server, 
  AlertTriangle, 
  CheckCircle, 
  XCircle,
  Cpu,
  HardDrive,
  Network,
  Shield,
  Clock,
  Users,
  Lock,
  FileText,
  Settings
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format uptime
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Format timestamp
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// Health status badge
function HealthBadge({ status }: { status: 'healthy' | 'degraded' | 'critical' }) {
  const variants = {
    healthy: { variant: 'default' as const, icon: CheckCircle, color: 'text-green-500' },
    degraded: { variant: 'secondary' as const, icon: AlertTriangle, color: 'text-yellow-500' },
    critical: { variant: 'destructive' as const, icon: XCircle, color: 'text-red-500' },
  };
  const { variant, icon: Icon, color } = variants[status];
  
  return (
    <Badge variant={variant} className="flex items-center gap-1">
      <Icon className={`h-3 w-3 ${color}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

// Log level badge
function LogLevelBadge({ level }: { level: 'info' | 'warn' | 'error' | 'debug' }) {
  const variants = {
    info: 'default' as const,
    warn: 'secondary' as const,
    error: 'destructive' as const,
    debug: 'outline' as const,
  };
  
  return <Badge variant={variants[level]}>{level.toUpperCase()}</Badge>;
}

export default function MonitoringPage() {
  const [data, setData] = useState<MonitoringDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { toast } = useToast();

  const loadData = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    try {
      const response = await api.getMonitoringDashboard();
      setData(response.data);
    } catch (error) {
      toast({ 
        title: "Error", 
        description: "Failed to load monitoring data", 
        variant: "destructive" 
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(() => {
      loadData(false);
    }, 10000);
    
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center text-muted-foreground">
        Failed to load monitoring data
      </div>
    );
  }

  return (
    <div className="container py-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Activity className="h-8 w-8" />
            System Monitoring
          </h1>
          <p className="text-muted-foreground">Real-time system health and metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? 'Pause' : 'Resume'} Auto-refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadData(true)}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Health Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4" />
              Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <HealthBadge status={data.health.status} />
            <p className="text-xs text-muted-foreground mt-1">
              Uptime: {formatUptime(data.health.uptime)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              Memory
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.health.memory.percentage.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(data.health.memory.heapUsed)} / {formatBytes(data.health.memory.heapTotal)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              CPU Load
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.health.cpu.loadAverage[0]?.toFixed(2) || '0.00'}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.health.cpu.cores} cores
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Network className="h-4 w-4" />
              Connections
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.health.connections.agents + data.health.connections.clients}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.health.connections.agents} agents, {data.health.connections.clients} clients
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs for different sections */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Memory Chart */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Memory Usage</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={data.history.slice(-30)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="timestamp" 
                      tickFormatter={formatTime}
                      fontSize={12}
                    />
                    <YAxis 
                      tickFormatter={(v) => formatBytes(v)}
                      fontSize={12}
                    />
                    <Tooltip 
                      labelFormatter={formatTime}
                      formatter={(value) => [formatBytes(Number(value) || 0), 'Heap Used']}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="memory.heapUsed" 
                      stroke="#8884d8" 
                      fill="#8884d8" 
                      fillOpacity={0.3}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Connections Chart */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Active Connections</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={data.history.slice(-30)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="timestamp" 
                      tickFormatter={formatTime}
                      fontSize={12}
                    />
                    <YAxis fontSize={12} />
                    <Tooltip labelFormatter={formatTime} />
                    <Line 
                      type="monotone" 
                      dataKey="connections.agents" 
                      stroke="#82ca9d" 
                      name="Agents"
                    />
                    <Line 
                      type="monotone" 
                      dataKey="connections.clients" 
                      stroke="#8884d8" 
                      name="Clients"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Quick Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Auth Success
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold text-green-500">
                  {data.auth.successCount}
                </div>
                <p className="text-xs text-muted-foreground">
                  {((1 - data.auth.failureRate) * 100).toFixed(1)}% success rate
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Auth Failures
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold text-red-500">
                  {data.auth.failureCount}
                </div>
                <p className="text-xs text-muted-foreground">
                  {(data.auth.failureRate * 100).toFixed(1)}% failure rate
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Map Sizes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm">
                  <div>Pending: {data.health.mapSizes.pendingRequests}</div>
                  <div>Cache: {data.health.mapSizes.orgPlanCache}</div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Metrics Tab */}
        <TabsContent value="metrics" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Rate Limit Statistics</CardTitle>
              <CardDescription>Track rate limit hits across endpoints</CardDescription>
            </CardHeader>
            <CardContent>
              {data.rateLimits.length === 0 ? (
                <p className="text-muted-foreground">No rate limit data yet</p>
              ) : (
                <div className="space-y-2">
                  {data.rateLimits.map((stat, i) => (
                    <div key={i} className="flex justify-between items-center p-2 border rounded">
                      <div>
                        <div className="font-medium">{stat.endpoint}</div>
                        <div className="text-xs text-muted-foreground">
                          Last hit: {formatDateTime(stat.lastHit)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm">
                          <span className="text-green-500">{stat.hits - stat.blocked}</span>
                          {' / '}
                          <span className="text-red-500">{stat.blocked}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          allowed / blocked
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connection Limits</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Agents</div>
                  <div className="text-lg font-bold">
                    {data.health.connections.agents} / {data.health.connections.maxAgents}
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2 mt-1">
                    <div 
                      className="bg-primary h-2 rounded-full" 
                      style={{ 
                        width: `${(data.health.connections.agents / data.health.connections.maxAgents) * 100}%` 
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Clients</div>
                  <div className="text-lg font-bold">
                    {data.health.connections.clients} / {data.health.connections.maxClients}
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2 mt-1">
                    <div 
                      className="bg-primary h-2 rounded-full" 
                      style={{ 
                        width: `${(data.health.connections.clients / data.health.connections.maxClients) * 100}%` 
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Unique IPs</div>
                  <div className="text-lg font-bold">
                    {data.health.connections.perIpCount}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs">
          <Card>
            <CardHeader>
              <CardTitle>System Logs</CardTitle>
              <CardDescription>Recent system events and errors</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px]">
                <div className="space-y-2">
                  {data.logs.map((log, i) => (
                    <div 
                      key={i} 
                      className={`p-2 border rounded text-sm ${
                        log.level === 'error' ? 'border-red-500/50 bg-red-500/5' :
                        log.level === 'warn' ? 'border-yellow-500/50 bg-yellow-500/5' :
                        ''
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <LogLevelBadge level={log.level} />
                        <Badge variant="outline">{log.category}</Badge>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {formatDateTime(log.timestamp)}
                        </span>
                      </div>
                      <p className="mt-1">{log.message}</p>
                      {log.metadata && (
                        <pre className="text-xs text-muted-foreground mt-1 overflow-x-auto">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                  {data.logs.length === 0 && (
                    <p className="text-muted-foreground text-center py-8">
                      No logs yet
                    </p>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security Tab */}
        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Authentication Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Total Success</div>
                  <div className="text-2xl font-bold text-green-500">{data.auth.successCount}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Total Failures</div>
                  <div className="text-2xl font-bold text-red-500">{data.auth.failureCount}</div>
                </div>
              </div>
              
              {data.auth.topFailedIdentifiers.length > 0 && (
                <div className="mt-4">
                  <div className="text-sm font-medium mb-2">Top Failed Identifiers</div>
                  <div className="space-y-1">
                    {data.auth.topFailedIdentifiers.map((item, i) => (
                      <div key={i} className="flex justify-between text-sm p-2 bg-secondary rounded">
                        <span className="font-mono">{item.identifier}</span>
                        <span className="text-red-500">{item.count} failures</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config">
          <ConfigurationPanel config={data.config} onUpdate={loadData} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Configuration Panel Component
function ConfigurationPanel({ 
  config, 
  onUpdate 
}: { 
  config: MonitoringConfig; 
  onUpdate: () => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [fullConfig, setFullConfig] = useState<SystemConfig | null>(null);

  useEffect(() => {
    loadFullConfig();
  }, []);

  const loadFullConfig = async () => {
    try {
      const response = await api.getSystemConfig();
      setFullConfig(response.config);
    } catch (error) {
      toast({ title: "Error", description: "Failed to load configuration", variant: "destructive" });
    }
  };

  const handleSave = async () => {
    if (!fullConfig) return;
    
    setLoading(true);
    try {
      await api.updateSystemConfig(fullConfig);
      toast({ title: "Success", description: "Configuration updated" });
      onUpdate();
    } catch (error) {
      toast({ title: "Error", description: "Failed to update configuration", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  if (!fullConfig) {
    return <Loader2 className="animate-spin" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings className="h-5 w-5" />
          System Configuration
        </CardTitle>
        <CardDescription>
          Configure system limits and features
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Connection Limits */}
        <div>
          <h3 className="font-medium mb-2">Connection Limits</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-sm text-muted-foreground">Max Agent Connections</label>
              <input
                type="number"
                className="w-full p-2 border rounded mt-1"
                value={fullConfig.maxAgentConnections}
                onChange={(e) => setFullConfig({
                  ...fullConfig,
                  maxAgentConnections: parseInt(e.target.value) || 0
                })}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Max Client Connections</label>
              <input
                type="number"
                className="w-full p-2 border rounded mt-1"
                value={fullConfig.maxClientConnections}
                onChange={(e) => setFullConfig({
                  ...fullConfig,
                  maxClientConnections: parseInt(e.target.value) || 0
                })}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Max Connections Per IP</label>
              <input
                type="number"
                className="w-full p-2 border rounded mt-1"
                value={fullConfig.maxConnectionsPerIp}
                onChange={(e) => setFullConfig({
                  ...fullConfig,
                  maxConnectionsPerIp: parseInt(e.target.value) || 0
                })}
              />
            </div>
          </div>
        </div>

        {/* Rate Limits */}
        <div>
          <h3 className="font-medium mb-2">Rate Limits</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 border rounded">
              <div className="font-medium text-sm">Auth Rate Limit</div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="text-xs text-muted-foreground">Requests</label>
                  <input
                    type="number"
                    className="w-full p-1 border rounded text-sm"
                    value={fullConfig.rateLimits.auth.requests}
                    onChange={(e) => setFullConfig({
                      ...fullConfig,
                      rateLimits: {
                        ...fullConfig.rateLimits,
                        auth: { ...fullConfig.rateLimits.auth, requests: parseInt(e.target.value) || 0 }
                      }
                    })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Window (min)</label>
                  <input
                    type="number"
                    className="w-full p-1 border rounded text-sm"
                    value={fullConfig.rateLimits.auth.windowMinutes}
                    onChange={(e) => setFullConfig({
                      ...fullConfig,
                      rateLimits: {
                        ...fullConfig.rateLimits,
                        auth: { ...fullConfig.rateLimits.auth, windowMinutes: parseInt(e.target.value) || 0 }
                      }
                    })}
                  />
                </div>
              </div>
            </div>
            <div className="p-3 border rounded">
              <div className="font-medium text-sm">HTTP Rate Limit</div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="text-xs text-muted-foreground">Requests</label>
                  <input
                    type="number"
                    className="w-full p-1 border rounded text-sm"
                    value={fullConfig.rateLimits.http.requests}
                    onChange={(e) => setFullConfig({
                      ...fullConfig,
                      rateLimits: {
                        ...fullConfig.rateLimits,
                        http: { ...fullConfig.rateLimits.http, requests: parseInt(e.target.value) || 0 }
                      }
                    })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Window (min)</label>
                  <input
                    type="number"
                    className="w-full p-1 border rounded text-sm"
                    value={fullConfig.rateLimits.http.windowMinutes}
                    onChange={(e) => setFullConfig({
                      ...fullConfig,
                      rateLimits: {
                        ...fullConfig.rateLimits,
                        http: { ...fullConfig.rateLimits.http, windowMinutes: parseInt(e.target.value) || 0 }
                      }
                    })}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Features */}
        <div>
          <h3 className="font-medium mb-2">Features</h3>
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fullConfig.features.waitingListEnabled}
                onChange={(e) => setFullConfig({
                  ...fullConfig,
                  features: { ...fullConfig.features, waitingListEnabled: e.target.checked }
                })}
              />
              <span className="text-sm">Waiting List Enabled</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fullConfig.features.autoCleanupEnabled}
                onChange={(e) => setFullConfig({
                  ...fullConfig,
                  features: { ...fullConfig.features, autoCleanupEnabled: e.target.checked }
                })}
              />
              <span className="text-sm">Auto Cleanup Enabled</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fullConfig.features.crossServerRoutingEnabled}
                onChange={(e) => setFullConfig({
                  ...fullConfig,
                  features: { ...fullConfig.features, crossServerRoutingEnabled: e.target.checked }
                })}
              />
              <span className="text-sm">Cross-Server Routing Enabled</span>
            </label>
          </div>
        </div>

        <Button onClick={handleSave} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save Configuration
        </Button>
      </CardContent>
    </Card>
  );
}
