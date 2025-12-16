import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiKey } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Plus, Key, Copy, Trash2, RefreshCw, Check } from 'lucide-react';

const ALL_PERMISSIONS = [
  { id: 'tunnels:read', label: 'Read Tunnels' },
  { id: 'tunnels:write', label: 'Create Tunnels' },
  { id: 'tunnels:delete', label: 'Delete Tunnels' },
  { id: 'domains:read', label: 'Read Domains' },
  { id: 'domains:write', label: 'Create Domains' },
  { id: 'domains:delete', label: 'Delete Domains' },
  { id: 'agents:read', label: 'Read Agents' },
];

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
      <div className="flex flex-col items-center justify-center h-64">
        <Key className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium mb-2">No organization selected</h3>
        <p className="text-muted-foreground">
          Select an organization from the sidebar to manage API keys.
        </p>
      </div>
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">API Keys</h1>
          <p className="text-muted-foreground">
            Manage API keys for {currentOrganization.name}
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) setNewKey(null);
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New API Key
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            {newKey ? (
              <>
                <DialogHeader>
                  <DialogTitle>API Key Created</DialogTitle>
                  <DialogDescription>
                    Copy your API key now. You won't be able to see it again!
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-2">
                    <Input value={newKey} readOnly className="font-mono text-sm" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => copyToClipboard(newKey)}
                    >
                      {copiedKey === newKey ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => { setIsDialogOpen(false); setNewKey(null); }}>
                    Done
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Create API Key</DialogTitle>
                  <DialogDescription>
                    Create a new API key with specific permissions.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Key Name</Label>
                    <Input
                      id="name"
                      placeholder="Production Server"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Permissions</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {ALL_PERMISSIONS.map((perm) => (
                        <label
                          key={perm.id}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedPermissions.includes(perm.id)}
                            onChange={() => togglePermission(perm.id)}
                            className="rounded border-gray-300"
                          />
                          {perm.label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !newKeyName.trim()}>
                    {createMutation.isPending ? 'Creating...' : 'Create'}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* API Keys List */}
      <div className="space-y-4">
        {data?.apiKeys.map((apiKey) => (
          <Card key={apiKey.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 rounded-lg">
                    <Key className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{apiKey.name}</CardTitle>
                    <CardDescription className="font-mono">{apiKey.keyPrefix}...</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm('Rotate this API key? The old key will be revoked immediately.')) {
                        rotateMutation.mutate(apiKey.id);
                      }
                    }}
                    disabled={rotateMutation.isPending}
                  >
                    <RefreshCw className="h-4 w-4 mr-1" />
                    Rotate
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      if (confirm('Revoke this API key? This action cannot be undone.')) {
                        revokeMutation.mutate(apiKey.id);
                      }
                    }}
                    disabled={revokeMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Revoke
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {apiKey.permissions.map((perm) => (
                  <span key={perm} className="text-xs bg-secondary px-2 py-1 rounded-full">
                    {perm}
                  </span>
                ))}
              </div>
              <div className="flex gap-4 mt-4 text-sm text-muted-foreground">
                <span>Created: {new Date(apiKey.createdAt).toLocaleDateString()}</span>
                {apiKey.lastUsedAt && (
                  <span>Last used: {new Date(apiKey.lastUsedAt).toLocaleDateString()}</span>
                )}
                {apiKey.expiresAt && (
                  <span>Expires: {new Date(apiKey.expiresAt).toLocaleDateString()}</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(!data?.apiKeys || data.apiKeys.length === 0) && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Key className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No API keys yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create your first API key to start using the tunnel service.
            </p>
            <Button onClick={() => setIsDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create API Key
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
