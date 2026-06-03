import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, EnhancedDomain, CNAME_TARGET } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
import { useToast } from '@/components/ui/use-toast';
import { 
  Plus, 
  Globe, 
  Copy, 
  MoreVertical,
  Trash2,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Server,
  Lock,
  Unlock,
  Radio,
  Settings,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Transform API domain data to UI format
interface DomainUIData {
  id: string;
  domain: string;
  status: 'active' | 'pending' | 'error';
  sslStatus: 'valid' | 'expiring' | 'expired' | 'pending' | 'none';
  sslExpiresAt: number | null;
  sslProvider: string | null;
  createdAt: number;
  dnsVerified: boolean;
  tunnelId: string | null;
  vpsRegion: string | null;
  cnameTarget: string;
  ownershipVerification?: { type?: string; name?: string; value?: string };
}

const transformDomain = (domain: EnhancedDomain): DomainUIData => ({
  id: domain.id,
  domain: domain.domain,
  status: domain.active ? 'active' : domain.sslStatus === 'pending' ? 'pending' : 'error',
  sslStatus: domain.sslStatus,
  sslExpiresAt: domain.certExpiry || null,
  // Certs are provisioned by Cloudflare for SaaS (no Let's Encrypt/Certbot).
  sslProvider: domain.sslStatus !== 'none' ? 'Cloudflare' : null,
  createdAt: domain.createdAt,
  dnsVerified: domain.dnsVerified,
  tunnelId: domain.tunnelCount > 0 ? 'has-tunnels' : null,
  vpsRegion: domain.synced ? 'Synced' : null,
  cnameTarget: domain.cnameTarget || CNAME_TARGET,
  ownershipVerification: domain.ownershipVerification,
});

const formatDate = (timestamp: number | null) => {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const getDaysUntilExpiry = (timestamp: number | null) => {
  if (!timestamp) return null;
  const days = Math.floor((timestamp - Date.now()) / 86400000);
  return days;
};

export default function DomainsPage() {
  const { currentOrganization } = useAuth();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'pending'>('all');

  // Fetch domains from API
  const { data: domainsData, isLoading } = useQuery({
    queryKey: ['domains', 'enhanced', currentOrganization?.id],
    queryFn: () => api.getEnhancedDomains(),
    enabled: !!currentOrganization,
    refetchInterval: 60000, // Refresh every minute
  });

  const domains = domainsData?.domains?.map(transformDomain) || [];

  const filteredDomains = domains.filter(domain => {
    const matchesSearch = domain.domain.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || domain.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const activeDomains = domains.filter(d => d.status === 'active').length;
  const pendingDomains = domains.filter(d => d.status === 'pending').length;
  const expiringCerts = domains.filter(d => d.sslStatus === 'expiring').length;

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast({
      title: 'Copied!',
      description: 'Domain copied to clipboard',
    });
  };

  const handleAddDomain = () => {
    toast({
      title: 'Domain added',
      description: 'Please verify DNS ownership to activate SSL',
    });
    setIsDialogOpen(false);
    setNewDomain('');
  };

  const getSSLBadge = (status: string, expiresAt: number | null) => {
    const daysLeft = getDaysUntilExpiry(expiresAt);
    
    switch (status) {
      case 'valid':
        return (
          <Badge variant="success" className="gap-1">
            <ShieldCheck className="h-3 w-3" />
            SSL Valid
          </Badge>
        );
      case 'expiring':
        return (
          <Badge variant="warning" className="gap-1">
            <ShieldAlert className="h-3 w-3" />
            Expires in {daysLeft}d
          </Badge>
        );
      case 'expired':
        return (
          <Badge variant="destructive" className="gap-1">
            <ShieldAlert className="h-3 w-3" />
            Expired
          </Badge>
        );
      case 'pending':
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Pending
          </Badge>
        );
      default:
        return null;
    }
  };

  if (!currentOrganization) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Radio className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-2">No organization selected</h3>
        <p className="text-muted-foreground text-center max-w-sm">
          Select an organization from the sidebar to manage your custom domains.
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
            <Radio className="h-7 w-7 text-primary" />
            Custom Domains
          </h1>
          <p className="text-muted-foreground mt-1">
            Connect your own domains with automatic SSL certificates
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 shadow-lg shadow-primary/25">
              <Plus className="h-4 w-4" />
              Add Domain
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Custom Domain</DialogTitle>
              <DialogDescription>
                Add your custom domain and we'll automatically provision an SSL certificate.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="domain">Domain Name</Label>
                <Input
                  id="domain"
                  placeholder="api.example.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                />
              </div>
              <div className="rounded-lg bg-muted/50 p-4 space-y-3">
                <p className="text-sm font-medium">DNS Configuration Required</p>
                <p className="text-xs text-muted-foreground">
                  After adding, create a <span className="font-medium">DNS-only (grey-cloud)</span> CNAME
                  record pointing to:
                </p>
                <code className="block text-xs bg-background px-3 py-2 rounded border">
                  {CNAME_TARGET}
                </code>
                <p className="text-xs text-muted-foreground">
                  Cloudflare then validates ownership and issues the SSL certificate automatically.
                </p>
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddDomain} disabled={!newDomain}>
                <Globe className="h-4 w-4 mr-2" />
                Add Domain
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Domains</p>
                <p className="text-3xl font-bold">{domains.length}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Globe className="h-6 w-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-emerald-500/10 to-transparent border-emerald-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active</p>
                <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">{activeDomains}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">{pendingDomains}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Clock className="h-6 w-6 text-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={expiringCerts > 0 ? "bg-gradient-to-br from-amber-500/10 to-transparent border-amber-500/20" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Expiring Soon</p>
                <p className={cn(
                  "text-3xl font-bold",
                  expiringCerts > 0 && "text-amber-600 dark:text-amber-400"
                )}>{expiringCerts}</p>
              </div>
              <div className={cn(
                "h-12 w-12 rounded-xl flex items-center justify-center",
                expiringCerts > 0 ? "bg-amber-500/10" : "bg-muted"
              )}>
                <ShieldAlert className={cn(
                  "h-6 w-6",
                  expiringCerts > 0 ? "text-amber-500" : "text-muted-foreground"
                )} />
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
                placeholder="Search domains..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)} className="w-auto">
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="active" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Active
                </TabsTrigger>
                <TabsTrigger value="pending" className="gap-1">
                  <Clock className="h-3 w-3" />
                  Pending
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* Domains List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Your Domains</CardTitle>
          <CardDescription>
            {filteredDomains.length} domain{filteredDomains.length !== 1 ? 's' : ''} configured
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredDomains.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Radio className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">No domains found</h3>
              <p className="text-muted-foreground text-center max-w-sm mb-4">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your filters'
                  : 'Add your first custom domain to get started'}
              </p>
              {!searchQuery && statusFilter === 'all' && (
                <Button onClick={() => setIsDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Domain
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredDomains.map((domain) => {
                const daysUntilExpiry = getDaysUntilExpiry(domain.sslExpiresAt);
                const expiryProgress = daysUntilExpiry ? Math.min(100, Math.max(0, (daysUntilExpiry / 90) * 100)) : 0;
                
                return (
                  <div 
                    key={domain.id}
                    className={cn(
                      "group relative overflow-hidden rounded-xl border p-4 transition-all hover:shadow-md",
                      domain.status === 'active' && domain.sslStatus === 'valid'
                        ? "bg-gradient-to-r from-emerald-500/5 to-transparent border-emerald-500/20 hover:border-emerald-500/40"
                        : domain.sslStatus === 'expiring'
                        ? "bg-gradient-to-r from-amber-500/5 to-transparent border-amber-500/20 hover:border-amber-500/40"
                        : "hover:bg-muted/30"
                    )}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                      {/* Domain Info */}
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        <div className={cn(
                          "h-12 w-12 rounded-xl flex items-center justify-center shrink-0",
                          domain.status === 'active' ? "bg-emerald-500/10" : "bg-muted"
                        )}>
                          {domain.dnsVerified ? (
                            <Lock className={cn(
                              "h-6 w-6",
                              domain.status === 'active' ? "text-emerald-500" : "text-muted-foreground"
                            )} />
                          ) : (
                            <Unlock className="h-6 w-6 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold truncate">{domain.domain}</h3>
                            {getSSLBadge(domain.sslStatus, domain.sslExpiresAt)}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                            {domain.dnsVerified ? (
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                DNS Verified
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-amber-500">
                                <AlertTriangle className="h-3 w-3" />
                                DNS Pending
                              </span>
                            )}
                            {domain.vpsRegion && (
                              <span className="flex items-center gap-1">
                                <Server className="h-3 w-3" />
                                {domain.vpsRegion}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* SSL Info */}
                      {domain.sslExpiresAt && (
                        <div className="lg:w-48 pl-16 lg:pl-0">
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-muted-foreground">SSL Certificate</span>
                            <span>{daysUntilExpiry}d left</span>
                          </div>
                          <Progress 
                            value={expiryProgress} 
                            className={cn(
                              "h-1.5",
                              daysUntilExpiry && daysUntilExpiry < 14 && "[&>div]:bg-amber-500"
                            )}
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Expires {formatDate(domain.sslExpiresAt)}
                          </p>
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pl-16 lg:pl-0">
                        {!domain.dnsVerified && (
                          <Button variant="outline" size="sm">
                            Verify DNS
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => copyToClipboard(domain.domain)}>
                              <Copy className="h-4 w-4 mr-2" />
                              Copy Domain
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <a href={`https://${domain.domain}`} target="_blank" rel="noopener">
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open in Browser
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => copyToClipboard(domain.cnameTarget)}>
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Refresh SSL Status
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                              <Settings className="h-4 w-4 mr-2" />
                              Configure
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive">
                              <Trash2 className="h-4 w-4 mr-2" />
                              Remove Domain
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {!domain.dnsVerified && (
                      <div className="mt-3 pt-3 border-t text-xs space-y-2">
                        <p className="text-muted-foreground">
                          Add this <span className="font-medium">DNS-only (grey-cloud)</span> CNAME, then verify:
                        </p>
                        <div className="flex items-center gap-2 font-mono bg-muted/50 rounded px-2 py-1 overflow-x-auto">
                          <span className="truncate">{domain.domain}</span>
                          <span className="text-muted-foreground">CNAME</span>
                          <span className="truncate font-medium">{domain.cnameTarget}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0"
                            onClick={() => copyToClipboard(domain.cnameTarget)}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                        {domain.ownershipVerification?.name && domain.ownershipVerification?.value && (
                          <>
                            <p className="text-muted-foreground">
                              And this TXT record to prove ownership:
                            </p>
                            <div className="font-mono bg-muted/50 rounded px-2 py-1 overflow-x-auto break-all">
                              {domain.ownershipVerification.name} TXT {domain.ownershipVerification.value}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* DNS Setup Guide */}
      <Card className="bg-gradient-to-br from-muted/50 to-transparent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            DNS Configuration Guide
          </CardTitle>
          <CardDescription>
            How to set up your custom domain with KProxy
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="p-4 rounded-xl border bg-card">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">1</div>
                <h4 className="font-medium">Add Domain</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                Add your custom domain to KProxy. We'll generate the DNS records you need.
              </p>
            </div>
            <div className="p-4 rounded-xl border bg-card">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">2</div>
                <h4 className="font-medium">Configure DNS</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                Add a DNS-only (grey-cloud) CNAME record pointing to <code className="text-xs bg-muted px-1 rounded">{CNAME_TARGET}</code>
              </p>
            </div>
            <div className="p-4 rounded-xl border bg-card">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">3</div>
                <h4 className="font-medium">SSL Auto-Provisioned</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                Once verified, we'll automatically provision and manage your SSL certificate.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
