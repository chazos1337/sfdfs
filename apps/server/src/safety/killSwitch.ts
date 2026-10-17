import { db, now } from '../db/db';
import { feed, getSettings, listAgents, pendingApprovals, updateAction, updateAgent, updateSettings } from '../db/repo';
import { abortAll } from '../runtime';
import { audit } from './audit';

export function isKilled(): boolean {
  return getSettings().kill_switch;
}

/**
 * Halts everything: aborts every running agent, revokes execution (the
 * gateway refuses all calls while the flag is set), expires pending
 * approvals and turns auto mode off. Stays engaged until re-armed by hand.
 */
export function engageKillSwitch(actor = 'user', reason = 'manual') {
  updateSettings({ kill_switch: true, auto_mode: false }, actor);
  abortAll('kill switch');
  for (const a of pendingApprovals()) updateAction(a.id, { status: 'expired', decided_at: now() });
  db.prepare("UPDATE crates SET status = 'queued', updated_at = ? WHERE status = 'in_progress'").run(now());
  for (const a of listAgents())
    updateAgent(a.id, {
      state: 'clocked_out',
      building: 'breakroom',
      bubble: 'Kill switch',
      progress: null,
      current_crate_id: null,
      current_run_id: null,
      current_opportunity_id: null,
      current_role: null,
    });
  audit(actor, 'kill_switch', null, { engaged: true, reason });
  feed('bad', `KILL SWITCH engaged (${reason}). All agents halted, execution revoked.`);
}

export function rearm(actor = 'user') {
  updateSettings({ kill_switch: false }, actor);
  for (const a of listAgents()) if (a.state === 'clocked_out') updateAgent(a.id, { state: 'idle', bubble: null });
  audit(actor, 'kill_switch', null, { engaged: false });
  feed('warn', 'Kill switch re-armed. Auto mode stays off until you turn it on.');
}
