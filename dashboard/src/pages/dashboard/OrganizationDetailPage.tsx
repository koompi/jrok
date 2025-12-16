import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { ArrowLeft, Users, Key, Trash2, Settings } from 'lucide-react';

export default function OrganizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['organization', id],
    queryFn: () => api.getOrganization(id!),
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteOrganization(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      refreshUser();
      navigate('/dashboard/organizations');
      toast({
        title: 'Organization deleted',
        description: 'The organization has been deleted.',
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const organization = data?.organization;
  if (!organization) {
    return <div>Organization not found</div>;
  }

  const isOwner = organization.ownerId === user?.id;
  const isAdmin = organization.members.some(
    m => m.userId === user?.id && (m.role === 'owner' || m.role === 'admin')
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard/organizations')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold">{organization.name}</h1>
          <p className="text-muted-foreground">{organization.slug}</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Subscription */}
        {organization.subscription && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Subscription
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Plan</span>
                <span className="font-medium">{organization.subscription.plan.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className={`font-medium ${
                  organization.subscription.status === 'active' ? 'text-green-600' : 'text-yellow-600'
                }`}>
                  {organization.subscription.status}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Period Ends</span>
                <span className="font-medium">
                  {new Date(organization.subscription.currentPeriodEnd).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Members */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Members
            </CardTitle>
            <CardDescription>
              {organization.members.length} member{organization.members.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {organization.members.map((member) => (
                <div key={member.userId} className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">
                      {member.userId === user?.id ? 'You' : `User ${member.userId.slice(0, 8)}...`}
                    </span>
                  </div>
                  <span className="text-xs bg-secondary px-2 py-1 rounded-full">
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Plan Limits */}
        {organization.subscription && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                Plan Limits
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Max Tunnels</div>
                  <div className="text-lg font-bold">
                    {organization.subscription.plan.limits.maxTunnels === -1 
                      ? 'Unlimited' 
                      : organization.subscription.plan.limits.maxTunnels}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Max Domains</div>
                  <div className="text-lg font-bold">
                    {organization.subscription.plan.limits.maxDomains === -1 
                      ? 'Unlimited' 
                      : organization.subscription.plan.limits.maxDomains}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Max API Keys</div>
                  <div className="text-lg font-bold">
                    {organization.subscription.plan.limits.maxApiKeys === -1 
                      ? 'Unlimited' 
                      : organization.subscription.plan.limits.maxApiKeys}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Max Members</div>
                  <div className="text-lg font-bold">
                    {organization.subscription.plan.limits.maxMembers === -1 
                      ? 'Unlimited' 
                      : organization.subscription.plan.limits.maxMembers}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Danger Zone */}
        {isOwner && (
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <Trash2 className="h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription>
                Irreversible and destructive actions
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="destructive"
                onClick={() => {
                  if (confirm('Are you sure you want to delete this organization? This action cannot be undone.')) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete Organization'}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
