import { useState, useEffect } from 'react';
import { api, User, Organization, SystemSettings } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Check, X, Shield, Users, Building } from 'lucide-react';
import AdminOrgsPage from './dashboard/AdminOrgsPage';

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<'settings' | 'users' | 'orgs'>('settings');
  const { toast } = useToast();

  return (
    <div className="container py-10 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Super Admin Dashboard</h1>
      </div>

      <div className="flex space-x-4 border-b">
        <button
          className={`pb-2 px-4 ${activeTab === 'settings' ? 'border-b-2 border-primary font-bold' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          System Settings
        </button>
        <button
          className={`pb-2 px-4 ${activeTab === 'users' ? 'border-b-2 border-primary font-bold' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          Users
        </button>
        <button
          className={`pb-2 px-4 ${activeTab === 'orgs' ? 'border-b-2 border-primary font-bold' : ''}`}
          onClick={() => setActiveTab('orgs')}
        >
          Organizations
        </button>
      </div>

      {activeTab === 'settings' && <SystemSettingsTab />}
      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'orgs' && <AdminOrgsPage />}
    </div>
  );
}

function SystemSettingsTab() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.getSystemSettings();
      setSettings(data.settings);
    } catch (error) {
      toast({ title: "Error", description: "Failed to load settings", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const toggleWaitingList = async () => {
    if (!settings) return;
    try {
      const newValue = !settings.waitingListEnabled;
      await api.updateSystemSettings({ waitingListEnabled: newValue });
      setSettings({ ...settings, waitingListEnabled: newValue });
      toast({ title: "Success", description: `Waiting list ${newValue ? 'enabled' : 'disabled'}` });
    } catch (error) {
      toast({ title: "Error", description: "Failed to update settings", variant: "destructive" });
    }
  };

  if (loading) return <Loader2 className="animate-spin" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>General Settings</CardTitle>
        <CardDescription>Manage global system configurations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div>
            <h3 className="font-medium">Waiting List</h3>
            <p className="text-sm text-muted-foreground">
              If enabled, new users will be set to "Pending" status and cannot create organizations until approved.
            </p>
          </div>
          <Button 
            variant={settings?.waitingListEnabled ? "default" : "outline"}
            onClick={toggleWaitingList}
          >
            {settings?.waitingListEnabled ? "Enabled" : "Disabled"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const data = await api.adminListUsers();
      setUsers(data.users);
    } catch (error) {
      toast({ title: "Error", description: "Failed to load users", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const updateUserStatus = async (userId: string, status: string) => {
    try {
      await api.updateUserStatus(userId, status);
      setUsers(users.map(u => u.id === userId ? { ...u, status: status as any } : u));
      toast({ title: "Success", description: "User status updated" });
    } catch (error) {
      toast({ title: "Error", description: "Failed to update status", variant: "destructive" });
    }
  };

  if (loading) return <Loader2 className="animate-spin" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>User Management</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-4 font-medium">Name</th>
                <th className="p-4 font-medium">Email</th>
                <th className="p-4 font-medium">Role</th>
                <th className="p-4 font-medium">Status</th>
                <th className="p-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t">
                  <td className="p-4">{user.fullname}</td>
                  <td className="p-4">{user.email}</td>
                  <td className="p-4">{user.role}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      user.status === 'active' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100' :
                      user.status === 'pending' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100' :
                      'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100'
                    }`}>
                      {user.status || (user.isActive ? 'active' : 'disabled')}
                    </span>
                  </td>
                  <td className="p-4 flex gap-2">
                    {user.status !== 'active' && (
                      <Button size="sm" variant="outline" onClick={() => updateUserStatus(user.id, 'active')}>
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </Button>
                    )}
                    {user.status !== 'disabled' && (
                      <Button size="sm" variant="destructive" onClick={() => updateUserStatus(user.id, 'disabled')}>
                        <X className="w-4 h-4 mr-1" /> Disable
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}


