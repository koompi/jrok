import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, Organization } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import { Plus, Building2, Users, ArrowRight, Crown, Shield, User, Globe, Key, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function OrganizationsPage() {
  const { refreshUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newOrgName, setNewOrgName] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => api.getOrganizations(),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => api.createOrganization(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      refreshUser();
      setNewOrgName('');
      setIsDialogOpen(false);
      toast({
        title: 'Organization created',
        description: 'Your new organization is ready to use.',
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

  const handleCreate = () => {
    if (newOrgName.trim()) {
      createMutation.mutate(newOrgName.trim());
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'owner':
        return Crown;
      case 'admin':
        return Shield;
      default:
        return User;
    }
  };

  const getRoleBadgeVariant = (role: string): "default" | "secondary" | "warning" => {
    switch (role) {
      case 'owner':
        return 'warning';
      case 'admin':
        return 'default';
      default:
        return 'secondary';
    }
  };

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
            <Building2 className="h-7 w-7 text-primary" />
            Organizations
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your organizations and team members
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 shadow-lg shadow-primary/25">
              <Plus className="h-4 w-4" />
              New Organization
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Organization</DialogTitle>
              <DialogDescription>
                Create a new organization to manage tunnels and team members.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Organization Name</Label>
                <Input
                  id="name"
                  placeholder="My Company"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This will be used to identify your organization across Jrok.
                </p>
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending || !newOrgName.trim()}>
                {createMutation.isPending ? (
                  <>
                    <div className="animate-spin h-4 w-4 mr-2 border-2 border-current border-t-transparent rounded-full" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Create Organization
                  </>
                )}
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
                <p className="text-sm text-muted-foreground">Total Organizations</p>
                <p className="text-3xl font-bold">{data?.organizations?.length || 0}</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Building2 className="h-6 w-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Owner Role</p>
                <p className="text-3xl font-bold">
                  {data?.organizations?.filter(o => o.role === 'owner').length || 0}
                </p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Crown className="h-6 w-6 text-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Admin Role</p>
                <p className="text-3xl font-bold">
                  {data?.organizations?.filter(o => o.role === 'admin').length || 0}
                </p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Shield className="h-6 w-6 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Member Role</p>
                <p className="text-3xl font-bold">
                  {data?.organizations?.filter(o => o.role === 'member').length || 0}
                </p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center">
                <User className="h-6 w-6 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Organizations List */}
      {data?.organizations && data.organizations.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.organizations.map((org) => {
            const RoleIcon = getRoleIcon(org.role || 'member');
            
            return (
              <Card 
                key={org.id} 
                className={cn(
                  "group relative overflow-hidden transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5",
                  org.role === 'owner' && "border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-transparent"
                )}
              >
                {/* Role indicator */}
                {org.role === 'owner' && (
                  <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-to-br from-amber-500/20 to-transparent rounded-bl-full" />
                )}
                
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "h-12 w-12 rounded-xl flex items-center justify-center text-lg font-bold",
                        org.role === 'owner' 
                          ? "bg-gradient-to-br from-amber-500/20 to-amber-500/5 text-amber-600 dark:text-amber-400"
                          : "bg-primary/10 text-primary"
                      )}>
                        {org.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <CardTitle className="text-lg">{org.name}</CardTitle>
                        <CardDescription className="font-mono text-xs">{org.slug}</CardDescription>
                      </div>
                    </div>
                    {org.role && (
                      <Badge variant={getRoleBadgeVariant(org.role)} className="gap-1 text-[10px]">
                        <RoleIcon className="h-3 w-3" />
                        {org.role}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                
                <CardContent className="space-y-4">
                  {/* Stats row */}
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Users className="h-4 w-4" />
                      <span>{org.memberCount || 1} member{(org.memberCount || 1) !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Globe className="h-4 w-4" />
                      <span>0 tunnels</span>
                    </div>
                  </div>
                  
                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-2">
                    <Button variant="outline" size="sm" asChild className="flex-1">
                      <Link to={`/dashboard/organizations/${org.id}`}>
                        Manage
                        <ArrowRight className="h-4 w-4 ml-1 group-hover:translate-x-0.5 transition-transform" />
                      </Link>
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                      <Link to="/dashboard/api-keys">
                        <Key className="h-4 w-4" />
                      </Link>
                    </Button>
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
              <Building2 className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">No organizations yet</h3>
            <p className="text-muted-foreground text-center max-w-sm mb-6">
              Organizations help you manage tunnels, domains, and team members in one place.
            </p>
            <Button onClick={() => setIsDialogOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Your First Organization
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
