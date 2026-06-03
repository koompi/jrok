import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiKey } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { 
  Plus, Key, Copy, Trash2, RefreshCw, Check, Shield, 
  Eye, EyeOff, Clock, Calendar, AlertTriangle, Sparkles,
  Globe, Cpu, Server
} from 'lucide-react';
import { cn } from '@/lib/utils';

const PERMISSION_GROUPS = [
  {
    name: 'Tunnels',
    icon: Globe,
    permissions: [
      { id: 'tunnels:read', label: 'Read', description: 'View tunnel information' },
      { id: 'tunnels:write', label: 'Write', description: 'Create and modify tunnels' },
      { id: 'tunnels:delete', label: 'Delete', description: 'Remove tunnels' },
    ],
  },
  {
    name: 'Domains',
    icon: Server,
    permissions: [
      { id: 'domains:read', label: 'Read', description: 'View domain information' },
      { id: 'domains:write', label: 'Write', description: 'Add custom domains' },
      { id: 'domains:delete', label: 'Delete', description: 'Remove domains' },
    ],
  },
  {
    name: 'Agents',
    icon: Cpu,
    permissions: [
      { id: 'agents:read', label: 'Read', description: 'View connected agents' },
    ],
  },
];

const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap(g => g.permissions);

export default function ApiKeysPage() {
  const { currentOrganization } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(['tunnels:read', 'tunnels:write', 'agents:read']);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['apiKeys', currentOrganization?.id],
    queryFn: () => currentOrganization ? api.getApiKeys(currentOrganization.id) : null,
    enabled: !!currentOrganization,
  });

  const createMutation = useMutation({
    mutationFn: () => api.createApiKey(
      currentOrganization!.id,
      newKeyName,
      selectedPermissions
    ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['apiKeys', currentOrganization?.id] });
      setNewKey(data.apiKey.key);
      setNewKeyName('');
      setSelectedPermissions(['tunnels:read', 'tunnels:write', 'agents:read']);
      toast({
        title: 'API Key created',
        description: 'Make sure to copy your key now. You won\'t be able to see it again!',
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

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => api.revokeApiKey(currentOrganization!.id, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apiKeys', currentOrganization?.id] });
      toast({
        title: 'API Key revoked',
        description: 'The API key has been revoked and can no longer be used.',
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

  const rotateMutation = useMutation({
    mutationFn: (keyId: string) => api.rotateApiKey(currentOrganization!.id, keyId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['apiKeys', currentOrganization?.id] });
      setNewKey(data.apiKey.key);
      toast({
        title: 'API Key rotated',
        description: 'Your new API key is ready. The old key has been revoked.',
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

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(text);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const togglePermission = (permission: string) => {
    setSelectedPermissions(prev =>
      prev.includes(permission)
        ? prev.filter(p => p !== permission)
        : [...prev, permission]
    );
  };

  if (!currentOrganization) {
    return (
      <Card className="max-w-lg mx-auto mt-12 border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16">
          <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <Key className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-2">No organization selected</h3>
          <p className="text-muted-foreground text-center max-w-sm">
            Select an organization from the sidebar to manage API keys.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold flex items-center gap-2">
            <Key className="h-7 w-7 text-primary" />
            API Keys
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage API keys for <span className="font-medium text-foreground">{currentOrganization.name}</span>
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) setNewKey(null);
        }}>
          <DialogTrigger asChild>
            <Button className="gap-2 shadow-lg shadow-primary/25">
              <Plus className="h-4 w-4" />
              New API Key
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            {newKey ? (
              <>
                <DialogHeader>
                  <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
                    <Check className="h-6 w-6 text-emerald-500" />
                  </div>
                  <DialogTitle className="text-center">API Key Created!</DialogTitle>
                  <DialogDescription className="text-center">
                    Copy your API key now. You won't be able to see it again!
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="p-4 bg-muted rounded-lg">
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-sm font-mono break-all">{newKey}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => copyToClipboard(newKey)}
                      >
                        {copiedKey === newKey ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400 bg-amber-500/10 p-3 rounded-lg">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>Store this key securely. It provides access to your organization's resources.</p>
                  </div>
                </div>
                <DialogFooter>
                  <Button className="w-full" onClick={() => { setIsDialogOpen(false); setNewKey(null); }}>
                    I've Saved My Key
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Create API Key</DialogTitle>
                  <DialogDescription>
                    Create a new API key with specific permissions for your applications.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-6 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Key Name</Label>
                    <Input
                      id="name"
                      placeholder="e.g., Production Server, CI/CD Pipeline"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Use a descriptive name to identify this key's purpose.
                    </p>
                  </div>
                  
                  <div className="space-y-4">
                    <Label>Permissions</Label>
                    {PERMISSION_GROUPS.map((group) => {
                      const GroupIcon = group.icon;
                      const groupPermissionIds = group.permissions.map(p => p.id);
                      const hasAllGroupPermissions = groupPermissionIds.every(id => selectedPermissions.includes(id));
                      const hasSomeGroupPermissions = groupPermissionIds.some(id => selectedPermissions.includes(id));
                      
                      return (
                        <div key={group.name} className="border rounded-lg overflow-hidden">
                          <div className="flex items-center justify-between p-3 bg-muted/50">
                            <div className="flex items-center gap-2">
                              <GroupIcon className="h-4 w-4 text-muted-foreground" />
                              <span className="font-medium text-sm">{group.name}</span>
                            </div>
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline"
                              onClick={() => {
                                if (hasAllGroupPermissions) {
                                  setSelectedPermissions(prev => prev.filter(p => !groupPermissionIds.includes(p)));
                                } else {
                                  setSelectedPermissions(prev => [...new Set([...prev, ...groupPermissionIds])]);
                                }
                              }}
                            >
                              {hasAllGroupPermissions ? 'Deselect all' : 'Select all'}
                            </button>
                          </div>
                          <div className="p-3 space-y-2">
                            {group.permissions.map((perm) => (
                              <label
                                key={perm.id}
                                className={cn(
                                  "flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors",
                                  selectedPermissions.includes(perm.id) 
                                    ? "bg-primary/5 border border-primary/20" 
                                    : "hover:bg-muted/50"
                                )}
                              >
                                <div className="flex items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={selectedPermissions.includes(perm.id)}
                                    onChange={() => togglePermission(perm.id)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary"
                                  />
                                  <div>
                                    <p className="text-sm font-medium">{perm.label}</p>
                                    <p className="text-xs text-muted-foreground">{perm.description}</p>
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <DialogFooter className="flex-col sm:flex-row gap-2">
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button 
                    onClick={() => createMutation.mutate()} 
                    disabled={createMutation.isPending || !newKeyName.trim() || selectedPermissions.length === 0}
                    className="gap-2"
                  >
                    {createMutation.isPending ? (
                      <>
                        <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Create API Key
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Keys</p>
                <p className="text-3xl font-bold">{data?.apiKeys?.length || 0}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Key className="h-6 w-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Keys</p>
                <p className="text-3xl font-bold">{data?.apiKeys?.length || 0}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <Shield className="h-6 w-6 text-emerald-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Used Today</p>
                <p className="text-3xl font-bold">0</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Clock className="h-6 w-6 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Expiring Soon</p>
                <p className="text-3xl font-bold">0</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Calendar className="h-6 w-6 text-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* API Keys List */}
      {data?.apiKeys && data.apiKeys.length > 0 ? (
        <div className="space-y-4">
          {data.apiKeys.map((apiKey) => {
            const isExpiringSoon = apiKey.expiresAt && 
              new Date(apiKey.expiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;
            
            return (
              <Card 
                key={apiKey.id} 
                className={cn(
                  "group transition-all duration-300 hover:shadow-md",
                  isExpiringSoon && "border-amber-500/30 bg-gradient-to-r from-amber-500/5 to-transparent"
                )}
              >
                <CardContent className="pt-6">
                  <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                    {/* Key Info */}
                    <div className="flex items-start gap-4 flex-1">
                      <div className={cn(
                        "h-12 w-12 rounded-xl flex items-center justify-center shrink-0",
                        isExpiringSoon 
                          ? "bg-amber-500/10" 
                          : "bg-primary/10"
                      )}>
                        <Key className={cn(
                          "h-6 w-6",
                          isExpiringSoon ? "text-amber-500" : "text-primary"
                        )} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-lg">{apiKey.name}</h3>
                          <Badge variant="outline" className="font-mono text-xs">
                            {apiKey.keyPrefix}•••
                          </Badge>
                          {isExpiringSoon && (
                            <Badge variant="warning" className="gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Expiring soon
                            </Badge>
                          )}
                        </div>
                        
                        {/* Permissions */}
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {apiKey.permissions.map((perm) => {
                            const [resource, action] = perm.split(':');
                            return (
                              <Badge key={perm} variant="secondary" className="text-[10px] px-2 py-0.5">
                                {resource}:{action}
                              </Badge>
                            );
                          })}
                        </div>
                        
                        {/* Metadata */}
                        <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            Created {new Date(apiKey.createdAt).toLocaleDateString()}
                          </span>
                          {apiKey.lastUsedAt ? (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Last used {new Date(apiKey.lastUsedAt).toLocaleDateString()}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                              <Clock className="h-3 w-3" />
                              Never used
                            </span>
                          )}
                          {apiKey.expiresAt && (
                            <span className={cn(
                              "flex items-center gap-1",
                              isExpiringSoon && "text-amber-600 dark:text-amber-400 font-medium"
                            )}>
                              <AlertTriangle className="h-3 w-3" />
                              Expires {new Date(apiKey.expiresAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0 lg:ml-4">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          if (confirm('Rotate this API key? The old key will be revoked immediately.')) {
                            rotateMutation.mutate(apiKey.id);
                          }
                        }}
                        disabled={rotateMutation.isPending}
                      >
                        <RefreshCw className={cn(
                          "h-4 w-4",
                          rotateMutation.isPending && "animate-spin"
                        )} />
                        Rotate
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          if (confirm('Revoke this API key? This action cannot be undone.')) {
                            revokeMutation.mutate(apiKey.id);
                          }
                        }}
                        disabled={revokeMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                        Revoke
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Key className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">No API keys yet</h3>
            <p className="text-muted-foreground text-center max-w-sm mb-6">
              API keys allow you to authenticate your applications and CLI tools with KProxy.
            </p>
            <Button onClick={() => setIsDialogOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Your First API Key
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Help Section */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <h3 className="font-semibold mb-2">Using API Keys</h3>
          <p className="text-sm text-muted-foreground mb-4">
            API keys authenticate your CLI and applications with KProxy. Keep them secure and never share them publicly.
          </p>
          <div className="bg-background rounded-lg p-4 font-mono text-sm">
            <p className="text-muted-foreground mb-2"># Authenticate with the CLI</p>
            <p className="text-primary">kproxy auth --token YOUR_API_KEY</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
