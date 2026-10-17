import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_SCHEMAS, type Role } from '@mf/shared';
import { z } from 'zod';
import { config } from '../config';

const here = path.dirname(fileURLToPath(import.meta.url));
const promptDir = path.join(here, 'prompts');

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RoleSpec {
  role: Role;
  model: string;
  effort: Effort;
  maxTurns: number;
  /** Built-in tools the role may use. Everything else is unavailable. */
  builtinTools: string[];
  /** Only executors get the yard gateway (wallet + email). */
  usesYard: boolean;
}

// The tool sandbox for each role. This is the enforcement point for "thinkers
// read the web but can't touch money; executors touch money but can't read
// the web": the SDK is started with exactly these tools and no others.
export const ROLES: Record<Role, RoleSpec> = {
  scout: { role: 'scout', model: config.MODEL_SCOUT, effort: 'medium', maxTurns: 25, builtinTools: ['WebSearch', 'WebFetch'], usesYard: false },
  research: { role: 'research', model: config.MODEL_RESEARCH, effort: 'medium', maxTurns: 30, builtinTools: ['WebSearch', 'WebFetch'], usesYard: false },
  market: { role: 'market', model: config.MODEL_MARKET, effort: 'medium', maxTurns: 30, builtinTools: ['WebSearch', 'WebFetch'], usesYard: false },
  validation: { role: 'validation', model: config.MODEL_VALIDATION, effort: 'high', maxTurns: 20, builtinTools: ['WebSearch', 'WebFetch'], usesYard: false },
  planner: { role: 'planner', model: config.MODEL_PLANNER, effort: 'high', maxTurns: 4, builtinTools: [], usesYard: false },
  executor: { role: 'executor', model: config.MODEL_EXECUTOR, effort: 'medium', maxTurns: 30, builtinTools: [], usesYard: true },
};

function readPrompt(name: string) {
  return fs.readFileSync(path.join(promptDir, `${name}.md`), 'utf8').trim();
}

export function systemPrompt(role: Role, vars: Record<string, string | number> = {}): string {
  let text = readPrompt(role);
  const all: Record<string, string | number> = { untrusted: readPrompt('_untrusted'), max_ideas: 3, ...vars };
  text = text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(all[k] ?? ''));
  return text;
}

/** Content hash of the prompt files a role uses, stored on every run. */
export function promptVersion(role: Role): string {
  const h = crypto.createHash('sha256').update(readPrompt(role));
  if (role !== 'planner' && role !== 'executor') h.update(readPrompt('_untrusted'));
  return h.digest('hex').slice(0, 12);
}

export function outputSchema(role: Role) {
  return ROLE_SCHEMAS[role];
}

export function outputJsonSchema(role: Role): Record<string, unknown> {
  const schema = z.toJSONSchema(ROLE_SCHEMAS[role], { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
