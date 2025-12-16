import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import RuixenBentoCards from '@/components/ui/ruixen-bento-cards';
import { useQuery } from '@tanstack/react-query';
import { api, Plan } from '@/lib/api';
import { ModeToggle } from '@/components/mode-toggle';
import { GLSLHills } from '@/components/ui/glsl-hills';
import { TerminalDemo } from '@/components/TerminalDemo';
import { 
  Server, 
  Check, 
  ArrowRight 
} from 'lucide-react';

const FALLBACK_PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tier: 'free',
    description: 'Perfect for hobbyists and testing',
    price: 0,
    currency: 'USD',
    interval: 'month',
    features: [
      { name: '1 Tunnel', included: true },
      { name: 'Random Domain', included: true },
      { name: 'HTTP/HTTPS', included: true },
      { name: 'Custom Domains', included: false },
      { name: 'Priority Support', included: false },
    ],
    limits: {
      maxTunnels: 1,
      maxDomains: 0,
      maxApiKeys: 1,
      maxMembers: 1,
      maxBandwidthGb: 1,
      sslIncluded: true,
      customDomains: false,
      prioritySupport: false,
    }
  },
  {
    id: 'pro',
    name: 'Pro',
    tier: 'pro',
    description: 'For professional developers',
    price: 900, // $9.00
    currency: 'USD',
    interval: 'month',
    features: [
      { name: '10 Tunnels', included: true },
      { name: 'Custom Domains', included: true },
      { name: 'Reserved Domains', included: true },
      { name: 'Team Management', included: true },
      { name: 'Priority Support', included: true },
    ],
    limits: {
      maxTunnels: 10,
      maxDomains: 5,
      maxApiKeys: 5,
      maxMembers: 5,
      maxBandwidthGb: 100,
      sslIncluded: true,
      customDomains: true,
      prioritySupport: true,
    }
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tier: 'enterprise',
    description: 'For large teams and organizations',
    price: 4900, // $49.00
    currency: 'USD',
    interval: 'month',
    features: [
      { name: 'Unlimited Tunnels', included: true },
      { name: 'Unlimited Domains', included: true },
      { name: 'SSO & Audit Logs', included: true },
      { name: 'Dedicated Support', included: true },
      { name: 'SLA', included: true },
    ],
    limits: {
      maxTunnels: 999,
      maxDomains: 999,
      maxApiKeys: 999,
      maxMembers: 999,
      maxBandwidthGb: 1000,
      sslIncluded: true,
      customDomains: true,
      prioritySupport: true,
    }
  }
];

export default function LandingPage() {
  const { isAuthenticated, login, isLoading } = useAuth();

  const { data: plansData } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.getPlans(),
  });

  const plans = (plansData?.plans && plansData.plans.length > 0) ? plansData.plans : FALLBACK_PLANS;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold">Jrok</span>
          </div>
          <nav className="flex items-center gap-4">
            <ModeToggle />
            {isAuthenticated ? (
              <Link to="/dashboard">
                <Button>Go to Dashboard</Button>
              </Link>
            ) : (
              <Button className='p-7' onClick={login}>Login with KOOMPI</Button>
            )}
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative h-[80vh] w-full flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 z-0">
          <GLSLHills />
        </div>
        <div className="container relative z-10 space-y-8 text-center pointer-events-none">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            EXPOSE YOUR LOCAL SERVICES
            <br />
            <span className="text-primary">SECURELY TO THE INTERNET</span>
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Create secure tunnels from your local development environment to the internet. 
            Perfect for webhooks, demos, and remote access.
          </p>
          <div className="flex gap-4 justify-center pointer-events-auto">
            {isAuthenticated ? (
              <Link to="/dashboard">
                <Button size="lg" className="gap-2">
                  Go to Dashboard <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <Button size="lg" className="gap-2" onClick={login}>
                Get Started Free <ArrowRight className="h-4 w-4" />
              </Button>
            )}
            <Button size="lg" variant="outline" asChild>
              <a href="https://github.com/yourusername/jrok" target="_blank" rel="noopener">
                View on GitHub
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <RuixenBentoCards />

      {/* Quick Start Section */}
      <section className="container py-24">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
            <h2 className="text-3xl font-bold">Quick Start</h2>
            <p className="text-xl text-muted-foreground">
              Get started with Jrok in minutes
            </p>
            
            <div className="space-y-6">
              <div className="flex gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold">
                  1
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">Create an API Key</h3>
                  <p className="text-muted-foreground">
                    Go to API Keys and create a new key for your application.
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold">
                  2
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">Install the CLI</h3>
                  <code className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm">
                    npm install -g @jrok/cli
                  </code>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold">
                  3
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">Start a Tunnel</h3>
                  <code className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm">
                    jrok --port 3000
                  </code>
                </div>
              </div>
            </div>
          </div>
          
          <div className="relative">
             <TerminalDemo />
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="container py-24 bg-muted/50 rounded-3xl border  ">
        <h2 className="text-3xl font-bold text-center mb-4">Simple, Transparent Pricing</h2>
        <p className="text-center text-muted-foreground mb-12">
          Start free and scale as you grow
        </p>
        <div className="grid md:grid-cols-4 gap-6 max-w-6xl mx-auto">
          {plans.map((plan) => (
            <Card key={plan.id} className={plan.tier === 'pro' ? 'border-primary shadow-lg' : ''}>
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                <div className="mt-4">
                  <span className="text-4xl font-bold">
                    ${(plan.price / 100).toFixed(2)}
                  </span>
                  <span className="text-muted-foreground">/{plan.interval}</span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <Check className={`h-4 w-4 ${feature.included ? 'text-green-500' : 'text-muted-foreground'}`} />
                      <span className={feature.included ? '' : 'text-muted-foreground line-through'}>
                        {feature.name}
                      </span>
                    </li>
                  ))}
                </ul>
                <Button 
                  className="w-full mt-6 p-6" 
                  variant={plan.tier === 'pro' ? 'default' : 'outline'}
                  onClick={isAuthenticated ? undefined : login}
                >
                  {plan.price === 0 ? 'Get Started' : 'Subscribe'}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="container py-24 text-center">
        <h2 className="text-3xl font-bold mb-4">Ready to Get Started?</h2>
        <p className="text-muted-foreground mb-8">
          Create your free account and start tunneling in minutes.
        </p>
        {isAuthenticated ? (
          <Link to="/dashboard">
            <Button size="lg">Go to Dashboard</Button>
          </Link>
        ) : (
          <Button size="lg" onClick={login}>Sign Up Free</Button>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="container flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-muted-foreground" />
            <span className="text-muted-foreground">Jrok</span>
          </div>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Jrok. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
