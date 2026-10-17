import { z } from 'zod';

// Structured outputs for every agent role. These are converted to JSON Schema
// for the Agent SDK's `outputFormat` and used to validate what comes back.
// Keep them free of numeric bounds/regexes: constraints live in descriptions
// and in code-side checks, which keeps the schemas portable.

export const Source = z.object({
  id: z.string().describe('Short id like "s1", referenced from other fields'),
  url: z.string(),
  title: z.string(),
  claim: z.string().describe('The specific fact this source supports'),
});
export type Source = z.infer<typeof Source>;

export const RedFlag = z.object({
  type: z.enum([
    'mlm',
    'guaranteed_returns',
    'pyramid_or_recruitment',
    'unlicensed_financial',
    'tos_violation',
    'deceptive',
    'copyright',
    'gambling',
    'platform_dependency',
    'scam_signals',
    'other',
  ]),
  severity: z.enum(['low', 'medium', 'high']),
  evidence: z.string(),
  source_id: z.string().optional(),
});
export type RedFlag = z.infer<typeof RedFlag>;

export const Injection = z.object({
  url: z.string(),
  quote: z.string().describe('Short verbatim quote of the instruction-like text'),
});
export type Injection = z.infer<typeof Injection>;

export const ScoutOutput = z.object({
  ideas: z.array(
    z.object({
      title: z.string().describe('At most 80 characters'),
      pitch: z.string().describe('2-3 sentences: what it is, who pays, why now'),
      category: z.enum(['service', 'digital_product', 'content', 'commerce', 'crypto', 'automation', 'other']),
      why_this_person: z.string(),
      est_startup_cost_usd: z.number(),
      est_hours_per_week: z.number(),
      needs_wallet_or_email: z.boolean(),
      sources: z.array(Source),
    }),
  ),
  injection_suspected: z.array(Injection),
});
export type ScoutOutput = z.infer<typeof ScoutOutput>;

export const ResearchOutput = z.object({
  summary: z.string(),
  how_it_works: z.string(),
  revenue_model: z.string(),
  real_examples: z.array(
    z.object({ name: z.string(), url: z.string(), evidence: z.string(), strength: z.enum(['strong', 'weak']) }),
  ),
  startup_costs: z.array(z.object({ item: z.string(), usd: z.number(), source_id: z.string().optional() })),
  requirements: z.object({
    skills: z.array(z.string()),
    accounts_or_platforms: z.array(z.string()),
  }),
  time_to_first_dollar_days: z.object({ low: z.number(), high: z.number(), reasoning: z.string() }),
  open_questions: z.array(z.string()),
  red_flags: z.array(RedFlag),
  sources: z.array(Source),
  injection_suspected: z.array(Injection),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const MarketOutput = z.object({
  demand: z.object({
    level: z.enum(['low', 'medium', 'high']),
    signals: z.array(z.object({ signal: z.string(), metric: z.string().optional(), source_id: z.string() })),
  }),
  competition: z.object({
    level: z.enum(['low', 'medium', 'high', 'saturated']),
    notable: z.array(z.object({ name: z.string(), url: z.string(), note: z.string() })),
  }),
  pricing: z.object({
    unit: z.string(),
    low_usd: z.number(),
    typical_usd: z.number(),
    high_usd: z.number(),
    source_ids: z.array(z.string()),
  }),
  trend: z.object({ direction: z.enum(['growing', 'stable', 'declining']), evidence: z.string() }),
  channels: z.array(z.string()),
  platform_risks: z.array(z.string()),
  red_flags: z.array(RedFlag),
  sources: z.array(Source),
  injection_suspected: z.array(Injection),
});
export type MarketOutput = z.infer<typeof MarketOutput>;

export const SCORE_DIMENSIONS = [
  'startup_cost',
  'time_to_first_dollar',
  'skill_fit',
  'risk',
  'scalability',
  'legality',
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

const Score = z.object({
  score: z.number().describe('0 to 10'),
  rationale: z.string(),
  source_ids: z.array(z.string()),
});

export const ValidationOutput = z.object({
  scores: z.object({
    startup_cost: Score.describe('10 = nearly free to start'),
    time_to_first_dollar: Score.describe('10 = first payment within days'),
    skill_fit: Score,
    risk: Score.describe('10 = very low risk of losing money, time or reputation'),
    scalability: Score,
    legality: Score.describe('10 = plainly legal and within platform rules; no jurisdiction research needed'),
  }),
  monthly_upside_usd: z.object({ low: z.number(), high: z.number(), assumptions: z.array(z.string()) }),
  startup_cost_usd: z.number(),
  confidence: z.number().describe('0 to 1'),
  verdict: z.enum(['approve', 'reject']),
  rejection_reason: z.string().optional(),
  red_flags: z.array(RedFlag),
  sources: z.array(Source),
  injection_suspected: z.array(Injection),
});
export type ValidationOutput = z.infer<typeof ValidationOutput>;

export const STEP_KINDS = [
  'human_task',
  'email_send',
  'wallet_read',
  'transfer',
  'swap',
  'x402_call',
  'card_purchase',
  'wait',
  'measure',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const PlanStep = z.object({
  id: z.string().describe('"s1", "s2", ...'),
  kind: z.enum(STEP_KINDS),
  description: z.string(),
  params: z
    .object({
      to: z.array(z.string()).optional().describe('Email addresses or wallet address; allowlisted or "<OWNER_TO_PROVIDE>"'),
      subject: z.string().optional(),
      body: z.string().optional(),
      chain: z.string().optional(),
      token: z.string().optional(),
      amount_usd: z.number().optional(),
      url: z.string().optional(),
      merchant: z.string().optional(),
      wait_hours: z.number().optional(),
    })
    .describe('Only the fields relevant to this step kind'),
  max_cost_usd: z.number(),
  depends_on: z.array(z.string()),
  success_check: z.string(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  objective: z.string(),
  budget_cap_usd: z.number(),
  review_after_days: z.number(),
  kpis: z.array(z.object({ name: z.string(), target: z.string() })),
  kill_criteria: z.array(z.string()),
  steps: z.array(PlanStep),
});
export type Plan = z.infer<typeof Plan>;

export const PlannerOutput = z.object({
  report_md: z.string(),
  plan: Plan,
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

export const ExecutorOutput = z.object({
  steps: z.array(
    z.object({
      step_id: z.string(),
      status: z.enum(['done', 'simulated', 'queued_for_approval', 'blocked', 'failed', 'skipped']),
      action_ids: z.array(z.number()),
      note: z.string(),
    }),
  ),
  human_tasks: z.array(z.string()),
  observed_revenue_usd: z.number().optional(),
  suspicious: z.array(z.object({ where: z.string(), quote: z.string() })),
  summary: z.string(),
});
export type ExecutorOutput = z.infer<typeof ExecutorOutput>;

export const ROLE_SCHEMAS = {
  scout: ScoutOutput,
  research: ResearchOutput,
  market: MarketOutput,
  validation: ValidationOutput,
  planner: PlannerOutput,
  executor: ExecutorOutput,
} as const;
