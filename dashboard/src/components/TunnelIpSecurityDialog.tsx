import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, TunnelIpSecurity } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { 
  Shield, 
  Plus,
  Trash2,
  Loader2,
  Globe,
  Lock,
  Ban,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface TunnelIpSecurityDialogProps {
  tunnelId: string;
  tunnelDomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TunnelIpSecurityDialog({ 
  tunnelId, 
  tunnelDomain, 
  open, 
  onOpenChange 
}: TunnelIpSecurityDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [mode, setMode] = useState<TunnelIpSecurity['mode']>('allow-all');
  const [allowedIps, setAllowedIps] = useState<string[]>([]);
  const [blockedIps, setBlockedIps] = useState<string[]>([]);
  const [newIp, setNewIp] = useState('');
  
  // Fetch current IP security settings
  const { data, isLoading } = useQuery({
    queryKey: ['tunnel-ip-security', tunnelId],
    queryFn: () => api.getTunnelIpSecurity(tunnelId),
    enabled: open && !!tunnelId,
  });
  
  // Update state when data is loaded
  useEffect(() => {
    if (data?.ipSecurity) {
      setMode(data.ipSecurity.mode || 'allow-all');
      setAllowedIps(data.ipSecurity.allowedIps || []);
      setBlockedIps(data.ipSecurity.blockedIps || []);
    }
  }, [data]);
  
  // Save mutation
  const saveMutation = useMutation({
    mutationFn: () => api.setTunnelIpSecurity(tunnelId, {
      mode,
      allowedIps,
      blockedIps,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tunnel-ip-security', tunnelId] });
      toast({
        title: 'IP Security Updated',
        description: `Security mode set to ${mode} for ${tunnelDomain}`,
      });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
  
  const handleAddIp = () => {
    if (!newIp.trim()) return;
    
    // Basic IP/CIDR validation
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    if (!ipRegex.test(newIp.trim())) {
      toast({
        title: 'Invalid IP',
        description: 'Enter a valid IP address (e.g., 192.168.1.1) or CIDR (e.g., 10.0.0.0/8)',
        variant: 'destructive',
      });
      return;
    }
    
    if (mode === 'allowlist') {
      if (!allowedIps.includes(newIp.trim())) {
        setAllowedIps([...allowedIps, newIp.trim()]);
      }
    } else if (mode === 'blocklist') {
      if (!blockedIps.includes(newIp.trim())) {
        setBlockedIps([...blockedIps, newIp.trim()]);
      }
    }
    setNewIp('');
  };
  
  const handleRemoveIp = (ip: string, list: 'allow' | 'block') => {
    if (list === 'allow') {
      setAllowedIps(allowedIps.filter(i => i !== ip));
    } else {
      setBlockedIps(blockedIps.filter(i => i !== ip));
    }
  };
  
  const getModeIcon = (m: TunnelIpSecurity['mode']) => {
    switch (m) {
      case 'allow-all': return <Globe className="h-4 w-4 text-emerald-500" />;
      case 'allowlist': return <Lock className="h-4 w-4 text-blue-500" />;
      case 'blocklist': return <Ban className="h-4 w-4 text-orange-500" />;
    }
  };
  
  const getModeDescription = (m: TunnelIpSecurity['mode']) => {
    switch (m) {
      case 'allow-all': return 'All IPs can access this tunnel (default)';
      case 'allowlist': return 'Only IPs in the list can access (whitelist)';
      case 'blocklist': return 'All IPs except those in the list can access (blacklist)';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            IP Security - {tunnelDomain}
          </DialogTitle>
          <DialogDescription>
            Control which IPs can access your tunnel. Applies to HTTP, HTTPS, WSS, and TCP.
          </DialogDescription>
        </DialogHeader>
        
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* Mode Selector */}
            <div className="space-y-2">
              <Label>Access Mode</Label>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant={mode === 'allow-all' ? 'default' : 'outline'}
                  className={cn(
                    "flex items-center gap-2 h-auto py-3",
                    mode === 'allow-all' && "bg-emerald-600 hover:bg-emerald-700"
                  )}
                  onClick={() => setMode('allow-all')}
                >
                  <Globe className="h-4 w-4" />
                  <span className="text-xs">Public</span>
                </Button>
                <Button
                  type="button"
                  variant={mode === 'allowlist' ? 'default' : 'outline'}
                  className={cn(
                    "flex items-center gap-2 h-auto py-3",
                    mode === 'allowlist' && "bg-blue-600 hover:bg-blue-700"
                  )}
                  onClick={() => setMode('allowlist')}
                >
                  <Lock className="h-4 w-4" />
                  <span className="text-xs">Allowlist</span>
                </Button>
                <Button
                  type="button"
                  variant={mode === 'blocklist' ? 'default' : 'outline'}
                  className={cn(
                    "flex items-center gap-2 h-auto py-3",
                    mode === 'blocklist' && "bg-orange-600 hover:bg-orange-700"
                  )}
                  onClick={() => setMode('blocklist')}
                >
                  <Ban className="h-4 w-4" />
                  <span className="text-xs">Blocklist</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {getModeDescription(mode)}
              </p>
            </div>
            
            {/* IP List Editor */}
            {mode !== 'allow-all' && (
              <div className="space-y-3">
                <Label>{mode === 'allowlist' ? 'Allowed IPs' : 'Blocked IPs'}</Label>
                
                {/* Add IP input */}
                <div className="flex gap-2">
                  <Input
                    placeholder="192.168.1.0/24 or 10.0.0.5"
                    value={newIp}
                    onChange={(e) => setNewIp(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleAddIp()}
                  />
                  <Button onClick={handleAddIp} size="sm">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                
                {/* IP List */}
                <div className="border rounded-lg max-h-48 overflow-y-auto">
                  {(mode === 'allowlist' ? allowedIps : blockedIps).length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      {mode === 'allowlist' 
                        ? '⚠️ No IPs added. All access will be blocked!'
                        : 'No IPs blocked. Add IPs to block specific addresses.'}
                    </div>
                  ) : (
                    <div className="divide-y">
                      {(mode === 'allowlist' ? allowedIps : blockedIps).map((ip) => (
                        <div key={ip} className="flex items-center justify-between px-3 py-2 hover:bg-muted/50">
                          <code className="text-sm">{ip}</code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemoveIp(ip, mode === 'allowlist' ? 'allow' : 'block')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                
                <p className="text-xs text-muted-foreground">
                  Supports individual IPs (192.168.1.1) and CIDR notation (10.0.0.0/8)
                </p>
              </div>
            )}
            
            {/* Status Preview */}
            <div className={cn(
              "p-3 rounded-lg border",
              mode === 'allow-all' && "bg-emerald-500/10 border-emerald-500/20",
              mode === 'allowlist' && "bg-blue-500/10 border-blue-500/20",
              mode === 'blocklist' && "bg-orange-500/10 border-orange-500/20",
            )}>
              <div className="flex items-center gap-2">
                {getModeIcon(mode)}
                <span className="font-medium text-sm">
                  {mode === 'allow-all' && 'Public Access'}
                  {mode === 'allowlist' && `${allowedIps.length} IPs Allowed`}
                  {mode === 'blocklist' && `${blockedIps.length} IPs Blocked`}
                </span>
              </div>
            </div>
          </div>
        )}
        
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={() => saveMutation.mutate()} 
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TunnelIpSecurityDialog;
