import Link from "next/link";
import { ArrowRight, Building2, Lock, ShieldCheck } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

export default function HomePage() {
  return (
    <div className="grid gap-8">
      <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-card via-card to-primary/10 p-8 shadow-lg shadow-black/30 sm:p-12">
        <div className="absolute inset-y-0 right-0 -z-0 hidden w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(15,118,110,0.18),transparent_60%)] lg:block" />
        <div className="relative grid gap-4">
          <Badge variant="outline" className="w-fit gap-1.5">
            <ShieldCheck className="h-3 w-3 text-primary" aria-hidden />
            Read-only · Encrypted in transit · Audit-logged
          </Badge>
          <h1 className="max-w-2xl text-3xl font-bold leading-tight tracking-tight text-foreground sm:text-4xl">
            RD-Sync gives your team a safe window into bank movements.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Private, employee-safe visibility into recent transactions. No bank logins shared,
            no MFA in employees&apos; hands, no money ever moves through this product.
          </p>
        </div>
      </section>

      <section aria-label="MVP preview flows" className="grid gap-4 sm:grid-cols-2">
        <FlowCard
          eyebrow="Employee flow"
          icon={Building2}
          title="View recent transactions"
          description="Browse the redesigned transaction dashboard with filters, search, and review states."
          href="/transactions"
          cta="Open transactions"
        />
        <FlowCard
          eyebrow="Admin demo flow"
          icon={Lock}
          title="Review scrape run operations"
          description="Preview MFA/session intervention, run history, and safe failure summaries."
          href="/admin/scrape-runs?previewRole=admin"
          cta="Open admin ops"
        />
      </section>
    </div>
  );
}

interface FlowCardProps {
  eyebrow: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description: string;
  href: string;
  cta: string;
}

function FlowCard({ eyebrow, icon: Icon, title, description, href, cta }: FlowCardProps) {
  return (
    <Link
      href={href}
      className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="h-full transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/50 group-hover:shadow-lg group-hover:shadow-primary/10">
        <CardHeader className="gap-2">
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="gap-1.5">
              <Icon className="h-3 w-3 text-primary" aria-hidden />
              {eyebrow}
            </Badge>
            <ArrowRight
              className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary"
              aria-hidden
            />
          </div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-transform group-hover:translate-x-0.5">
            {cta}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
