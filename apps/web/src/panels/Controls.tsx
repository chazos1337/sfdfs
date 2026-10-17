import { useEffect, useState } from 'react';
import { api, attempt } from '../net/api';
import { useFactory } from '../store/store';
import { useUi } from '../store/ui';
import { Confirm, Toggle } from './ui';

export default function Controls() {
  const settings = useFactory((s) => s.settings);
  const maxWorkers = useFactory((s) => s.maxWorkers);
  const approvals = useFactory((s) => Object.keys(s.approvals).length);
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const openSettings = useUi((s) => s.openSettings);
  const setTrayOpen = useUi((s) => s.setTrayOpen);
  const [confirmKill, setConfirmKill] = useState(false);
  const [workers, setWorkers] = useState<number | null>(null);
  const [budget, setBudget] = useState('');

  useEffect(() => {
    if (settings) setBudget(String(settings.daily_api_budget_usd));
  }, [settings?.daily_api_budget_usd]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings) return null;
  const killed = settings.kill_switch;
  const workerValue = workers ?? settings.worker_count;

  const commitWorkers = (n: number) => {
    setWorkers(null);
    if (n !== settings.worker_count) void attempt(() => api.putSettings({ worker_count: n }));
  };
  const commitBudget = () => {
    const n = Number(budget);
    if (!Number.isFinite(n) || n < 0) return setBudget(String(settings.daily_api_budget_usd));
    if (n !== settings.daily_api_budget_usd) void attempt(() => api.putSettings({ daily_api_budget_usd: n }));
  };

  return (
    <div className="px-frame flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
      <div className="flex">
        <button className={`px-btn ${tab === 'factory' ? 'on' : ''}`} onClick={() => setTab('factory')}>
          Factory
        </button>
        <button className={`px-btn ${tab === 'vault' ? 'on' : ''}`} onClick={() => setTab('vault')}>
          Vault
        </button>
      </div>

      <div className="h-6 w-[2px] bg-ink-600" />

      <Toggle on={settings.paused} onChange={(v) => attempt(() => api.pause(v))} label={settings.paused ? '▶ Resume' : '❚❚ Pause all'} title="Running agents finish their current step; nothing new starts" />
      <Toggle
        on={settings.auto_mode}
        disabled={killed}
        onChange={(v) => attempt(() => api.auto(v))}
        label={`Auto ${settings.auto_mode ? 'on' : 'off'}`}
        title={killed ? 'Re-arm the kill switch first' : 'Auto mode: the Scout keeps the dock stocked'}
      />

      <label className="flex items-center gap-2" title={`Worker slots (max ${maxWorkers}; upgrades raise it)`}>
        <span className="font-pixel text-[10px] uppercase text-ink-300">Workers</span>
        <input
          type="range"
          min={0}
          max={maxWorkers}
          step={1}
          value={workerValue}
          className="w-24 accent-[#ffd166]"
          onChange={(e) => setWorkers(Number(e.target.value))}
          onMouseUp={(e) => commitWorkers(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => commitWorkers(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commitWorkers(Number((e.target as HTMLInputElement).value))}
        />
        <span className="w-8 font-pixel text-[12px] text-gold">
          {workerValue}/{maxWorkers}
        </span>
      </label>

      <label className="flex items-center gap-1" title="Daily API budget (USD)">
        <span className="font-pixel text-[10px] uppercase text-ink-300">Budget $</span>
        <input
          className="px-input w-16 py-0.5 text-[12px]"
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={commitBudget}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="text-[11px] text-ink-400">/day</span>
      </label>

      <div className="ml-auto flex items-center gap-2">
        {approvals > 0 && (
          <button className="px-btn gold glow-pulse" onClick={() => setTrayOpen(true)} title="Actions waiting for your approval">
            ! {approvals} approval{approvals > 1 ? 's' : ''}
          </button>
        )}
        <button className="px-btn" title={settings.muted ? 'Sound off' : 'Sound on'} onClick={() => attempt(() => api.putSettings({ muted: !settings.muted }))}>
          {settings.muted ? '🔇 Muted' : '🔊 Sound'}
        </button>
        <button className="px-btn" onClick={() => openSettings(true)}>
          ⚙ Settings
        </button>
        <button
          className="px-btn bad"
          style={{ fontSize: 13, padding: '6px 14px', borderWidth: 3, background: killed ? '#3a0f18' : '#b0213d', boxShadow: 'inset -3px -3px 0 rgba(0,0,0,.4), inset 3px 3px 0 rgba(255,255,255,.15)' }}
          disabled={killed}
          onClick={() => setConfirmKill(true)}
          title="Abort every agent, revoke execution, expire approvals"
        >
          ■ Kill switch
        </button>
      </div>

      {confirmKill && (
        <Confirm
          title="Engage kill switch?"
          danger
          confirmLabel="Kill everything"
          body={
            <>
              This aborts every running agent, makes the yard gateway refuse <b>all</b> tool calls, expires pending approvals and turns auto mode off.
              <br />
              It stays engaged until you re-arm it.
            </>
          }
          onCancel={() => setConfirmKill(false)}
          onConfirm={() => {
            setConfirmKill(false);
            void attempt(() => api.kill());
          }}
        />
      )}
    </div>
  );
}

export function KillBanner() {
  const killed = useFactory((s) => s.settings?.kill_switch);
  const [busy, setBusy] = useState(false);
  if (!killed) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-[3px] border-bad bg-[#4a0d1a] px-3 py-1.5" style={{ boxShadow: '0 0 16px rgba(255,92,122,.45)' }}>
      <span className="blink font-pixel text-[14px] text-bad">■</span>
      <span className="font-pixel text-[13px] uppercase text-white">Kill switch engaged</span>
      <span className="text-[12px] text-ink-200">All agents halted, execution revoked, approvals expired. Nothing runs until you re-arm.</span>
      <button
        className="px-btn good ml-auto"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await attempt(() => api.rearm());
          setBusy(false);
        }}
      >
        Re-arm
      </button>
    </div>
  );
}
