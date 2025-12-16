import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Building2, Users, CreditCard } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function AdminOrgsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>("");

  const { data: orgsData, isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['admin-organizations'],
    queryFn: () => api.adminGetOrganizations(),
  });

  const { data: plansData } = useQuery({
    queryKey: ['admin-plans'],
    queryFn: () => api.adminGetPlans(),
  });

  const upgradeMutation = useMutation({
    mutationFn: ({ orgId, planId }: { orgId: string; planId: string }) => 
      api.adminUpgradePlan(orgId, planId),
    onSuccess: () => {
      toast({
        title: "Plan updated",
        description: "The organization's plan has been updated successfully.",
      });
      setSelectedOrg(null);
      queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update plan",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleUpgrade = () => {
    if (selectedOrg && selectedPlan) {
      upgradeMutation.mutate({ orgId: selectedOrg, planId: selectedPlan });
    }
  };

  if (isLoadingOrgs) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">All Organizations</h1>
        <p className="text-muted-foreground">
          View and manage all organizations on the platform.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {orgsData?.organizations.map((org) => (
          <Card key={org.id}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">{org.name}</CardTitle>
                  <CardDescription>{org.slug}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between text-sm mb-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Users className="h-4 w-4" />
                  {org.memberCount || 0} member{org.memberCount !== 1 ? 's' : ''}
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${org.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  {org.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Created: {new Date(org.createdAt).toLocaleDateString()}
              </div>
            </CardContent>
            <CardFooter>
              <Button 
                variant="outline" 
                className="w-full"
                onClick={() => {
                  setSelectedOrg(org.id);
                  setSelectedPlan(""); 
                }}
              >
                <CreditCard className="mr-2 h-4 w-4" />
                Change Plan
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedOrg} onOpenChange={(open) => !open && setSelectedOrg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Organization Plan</DialogTitle>
            <DialogDescription>
              Select a new plan for this organization. This will immediately update their subscription.
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              {plansData?.plans.map((plan) => (
                <div 
                  key={plan.id}
                  className={`flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors ${selectedPlan === plan.id ? 'border-primary bg-primary/5' : 'hover:bg-accent'}`}
                  onClick={() => setSelectedPlan(plan.id)}
                >
                  <div>
                    <div className="font-medium">{plan.name}</div>
                    <div className="text-sm text-muted-foreground">{plan.description}</div>
                  </div>
                  <div className="font-bold">
                    ${(plan.price / 100).toFixed(2)}/{plan.interval}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedOrg(null)}>Cancel</Button>
            <Button onClick={handleUpgrade} disabled={!selectedPlan || upgradeMutation.isPending}>
              {upgradeMutation.isPending ? "Updating..." : "Update Plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
