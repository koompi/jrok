import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Home,
  Building2,
  Key,
  Shield,
  LogOut,
  ChevronDown,
  Globe,
  Radio,
  Activity,
  Settings,
  HelpCircle,
  Zap,
  BarChart3,
  Bell,
  Search,
  Menu,
  X,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ModeToggle } from '@/components/mode-toggle';
import { useState } from 'react';
import jrokLogo from '@/public/jrok-logo.png';

interface NavItemType {
  name: string;
  href: string;
  icon: React.ElementType;
  description?: string;
  badge?: string;
}

const navigation: NavItemType[] = [
  { 
    name: 'Dashboard', 
    href: '/dashboard', 
    icon: Home,
    description: 'Overview & stats'
  },
  { 
    name: 'Tunnels', 
    href: '/dashboard/tunnels', 
    icon: Globe,
    description: 'Manage active tunnels',
    // badge: 'New'
  },
  { 
    name: 'Domains', 
    href: '/dashboard/domains', 
    icon: Radio,
    description: 'Custom domains & SSL'
  },
];

const secondaryNavigation: NavItemType[] = [
  { 
    name: 'Organizations', 
    href: '/dashboard/organizations', 
    icon: Building2,
  },
  { 
    name: 'API Keys', 
    href: '/dashboard/api-keys', 
    icon: Key,
  },
  { 
    name: 'Activity', 
    href: '/dashboard/activity', 
    icon: Activity,
  },
];

const adminNavigation: NavItemType[] = [
  { name: 'Admin Dashboard', href: '/dashboard/admin', icon: Shield },
];

export default function DashboardLayout() {
  const { user, logout, organizations, currentOrganization, setCurrentOrganization, isSuperAdmin } = useAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Mock data for UI
  const activeTunnels = 3;
  const hasNotifications = true;

  const NavItem = ({ item, isActive }: { item: NavItemType, isActive: boolean }) => (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={item.href}
            className={cn(
              'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
              isActive
                ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/25'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <item.icon className={cn(
              "h-5 w-5 transition-transform duration-200",
              !isActive && "group-hover:scale-110"
            )} />
            <span className="flex-1">{item.name}</span>
            {item.badge && (
              <Badge variant="info" className="text-[10px] px-1.5 py-0">
                {item.badge}
              </Badge>
            )}
          </Link>
        </TooltipTrigger>
        {item.description && (
          <TooltipContent side="right" className="hidden lg:block">
            <p>{item.description}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/30">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-72 bg-card backdrop-blur-xl transform transition-transform duration-300 lg:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full border-r border-border">
          {/* Logo Header */}
          <div className="flex h-16 items-center justify-between px-4 border-b">
            <Link to="/dashboard" className="flex items-center gap-2 group">
              <div className="relative">
                <img src={jrokLogo} alt="Jrok" className="h-9 w-9 transition-transform duration-300 group-hover:scale-110" />
                <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 bg-emerald-500 rounded-full border-2 border-card animate-pulse" />
              </div>
              <div className="flex flex-col">
                <span className="text-lg font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                  Jrok
                </span>
                <span className="text-[10px] text-muted-foreground -mt-1">Secure Tunnels</span>
              </div>
            </Link>
            <Button 
              variant="ghost" 
              size="icon" 
              className="lg:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Organization Selector */}
          <div className="p-4">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="outline" 
                  className="w-full justify-between h-auto py-3 px-3 bg-gradient-to-r from-muted/50 to-muted/30 border-muted-foreground/20 hover:border-primary/50 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Building2 className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex flex-col items-start">
                      <span className="text-sm font-medium truncate max-w-[140px]">
                        {currentOrganization?.name || 'Select Organization'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {currentOrganization?.slug || 'No org selected'}
                      </span>
                    </div>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64" align="start">
                <DropdownMenuLabel className="flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  Organizations
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {organizations.map((org) => (
                  <DropdownMenuItem
                    key={org.id}
                    onClick={() => setCurrentOrganization(org)}
                    className={cn(
                      "py-2.5 cursor-pointer",
                      currentOrganization?.id === org.id && 'bg-primary/10 text-primary'
                    )}
                  >
                    <div className="flex items-center gap-3 w-full">
                      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                        <span className="text-xs font-medium">{org.name.charAt(0)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{org.name}</p>
                        <p className="text-xs text-muted-foreground">{org.slug}</p>
                      </div>
                      {currentOrganization?.id === org.id && (
                        <Sparkles className="h-4 w-4 text-primary" />
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link to="/dashboard/organizations" className="flex items-center gap-2">
                    <Settings className="h-4 w-4" />
                    Manage Organizations
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <Separator />

          {/* Main Navigation */}
          <ScrollArea className="flex-1 px-4 py-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-3">
                Main
              </p>
              {navigation.map((item) => (
                <NavItem 
                  key={item.name}
                  item={item}
                  isActive={location.pathname === item.href}
                />
              ))}
            </div>

            <Separator className="my-4" />

            {/* Secondary Navigation */}
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-3">
                Management
              </p>
              {secondaryNavigation.map((item) => (
                <NavItem 
                  key={item.name}
                  item={item}
                  isActive={location.pathname === item.href || location.pathname.startsWith(item.href + '/')}
                />
              ))}
            </div>

            {/* Admin Section */}
            {isSuperAdmin && (
              <>
                <Separator className="my-4" />
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-3 flex items-center gap-2">
                    <Shield className="h-3 w-3" />
                    Admin
                  </p>
                  {adminNavigation.map((item) => (
                    <NavItem 
                      key={item.name}
                      item={item}
                      isActive={location.pathname === item.href}
                    />
                  ))}
                </div>
              </>
            )}
          </ScrollArea>

          {/* Quick Stats Card */}
          <div className="p-4">
            <div className="rounded-xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4 border border-primary/20">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">Quick Stats</span>
                <Zap className="h-4 w-4 text-primary" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-2 rounded-lg bg-background/50">
                  <p className="text-2xl font-bold text-primary">{activeTunnels}</p>
                  <p className="text-[10px] text-muted-foreground">Active</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-background/50">
                  <p className="text-2xl font-bold text-emerald-500">99.9%</p>
                  <p className="text-[10px] text-muted-foreground">Uptime</p>
                </div>
              </div>
            </div>
          </div>

          {/* Help & Docs */}
          <div className="p-4 border-t">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="flex-1 justify-start gap-2" asChild>
                <a href="https://github.com/koompi/jrok" target="_blank" rel="noopener">
                  <HelpCircle className="h-4 w-4" />
                  Documentation
                  <ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="lg:pl-72">
        {/* Top Bar */}
        <header className="sticky top-0 z-40 h-16 border-b bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-full items-center justify-between px-4 lg:px-6">
            {/* Left side - Mobile menu + Search */}
            <div className="flex items-center gap-4">
              <Button 
                variant="ghost" 
                size="icon" 
                className="lg:hidden"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              
              {/* Search Bar */}
              <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/50 border border-transparent focus-within:border-primary/50 focus-within:bg-background transition-all w-64">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input 
                  type="text"
                  placeholder="Search tunnels, domains..."
                  className="bg-transparent border-none outline-none text-sm placeholder:text-muted-foreground w-full"
                />
                <kbd className="hidden md:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                  ⌘K
                </kbd>
              </div>
            </div>

            {/* Right side */}
            <div className="flex items-center gap-2 sm:gap-4">
              {/* Bandwidth indicator */}
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50">
                <BarChart3 className="h-4 w-4 text-emerald-500" />
                <div className="flex flex-col">
                  <span className="text-xs font-medium">1.2 GB</span>
                  <span className="text-[10px] text-muted-foreground">This month</span>
                </div>
              </div>

              <Separator orientation="vertical" className="h-8 hidden md:block" />
              
              <ModeToggle />
              
              {/* Notifications */}
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="h-5 w-5" />
                {hasNotifications && (
                  <span className="absolute top-2 right-2 h-2 w-2 bg-destructive rounded-full" />
                )}
              </Button>

              {isSuperAdmin && (
                <Badge variant="default" className="hidden sm:flex gap-1">
                  <Shield className="h-3 w-3" />
                  Admin
                </Badge>
              )}
              
              {/* User Menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative h-9 w-9 rounded-full ring-2 ring-primary/20 hover:ring-primary/40 transition-all">
                    <Avatar className="h-9 w-9">
                      <AvatarImage src={user?.profile} alt={user?.fullname} />
                      <AvatarFallback className="bg-primary/10 text-primary font-medium">
                        {user?.fullname?.charAt(0) || 'U'}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64" align="end">
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex items-center gap-3 py-2">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={user?.profile} alt={user?.fullname} />
                        <AvatarFallback>{user?.fullname?.charAt(0) || 'U'}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col space-y-0.5">
                        <p className="text-sm font-medium">{user?.fullname}</p>
                        <p className="text-xs text-muted-foreground">{user?.email}</p>
                      </div>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="cursor-pointer">
                    <Settings className="h-4 w-4 mr-2" />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer">
                    <HelpCircle className="h-4 w-4 mr-2" />
                    Help & Support
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive">
                    <LogOut className="h-4 w-4 mr-2" />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
