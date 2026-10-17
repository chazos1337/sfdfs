import { useFactory } from '../store/store';
import { truncate, usd, usdShort } from '../util';
import { Badge, Bar } from './ui';

function Stat({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-center border-r-2 border-ink-700 px-3 last:border-r-0">
      <div className="font-pixel text-[9px] uppercase tracking-wider text-ink-300">{label}</div>
      <div className="font-pixel text-[15px] leading-tight" style={{ color: color ?? '#e4eaff' }}>
        {value}
      </div>
      {sub && <div className="truncate text-[10px] text-ink-400">{sub}</div>}
    </div>
  );
}

export default function Hud() {
  const hud = useFactory((s) => s.hud);
  const budget = useFactory((s) => s.budget);
  const settings = useFactory((s) => s.settings);
  const mock = useFactory((s) => s.mock);
  const live = useFactory((s) => s.liveEnabled);
  const connected = useFactory((s) => s.connected);
  const agents = useFactory((s) => s.agents);

  const fuel = budget && budget.api_cap_usd > 0 ? budget.api_spent_usd / budget.api_cap_usd : 0;
  const fuelColor = fuel >= 0.85 ? '#ff5c7a' : fuel >= 0.6 ? '#ffb454' : '#6fdc8c';
  const pnl = hud?.pnl ?? [];
  const working = Object.values(agents).filter((a) => a.state !== 'idle' && a.state !== 'clocked_out').length;

  return (
    <div className="px-frame flex h-[64px] shrink-0 items-stretch overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-r-[3px] border-ink-600 bg-ink-800 px-3">
        <div className="grid h-9 w-9 place-items-center border-2 border-gold bg-[#2a2410] font-pixel text-[18px] text-gold">$</div>
        <div>
          <div className="font-pixel text-[14px] leading-none text-gold">Money</div>
          <div className="font-pixel text-[14px] leading-none text-ink-100">Factory</div>
        </div>
      </div>

      <Stat label="Workers" value={`${hud?.active_workers ?? 0}/${settings?.worker_count ?? 0}`} sub={`${working} busy`} />
      <Stat label="Ideas today" value={hud?.ideas_processed_today ?? 0} />
      <Stat label="Vault" value={hud?.vault_count ?? 0} color="#ffd166" />

      <div className="flex w-[170px] shrink-0 flex-col justify-center border-r-2 border-ink-700 px-3" title={`API spend today ${usd(budget?.api_spent_usd, 3)} of ${usd(budget?.api_cap_usd)}`}>
        <div className="flex items-center justify-between font-pixel text-[9px] uppercase tracking-wider text-ink-300">
          <span>Fuel</span>
          <span style={{ color: fuelColor }} className={fuel >= 0.85 ? 'blink' : ''}>
            {usd(budget?.api_spent_usd)} / {usd(budget?.api_cap_usd, 0)}
          </span>
        </div>
        <Bar value={1 - fuel} color={fuelColor} segments={14} height={8} className="mt-1" />
      </div>

      <Stat label="Wallet" value={hud?.wallet_balance_usd == null ? '—' : usdShort(hud.wallet_balance_usd)} />
      <Stat
        label="Spent today"
        value={usd(budget?.wallet_spent_usd)}
        sub={
          <span className="text-ink-400">
            paper {usd(budget?.paper_spent_usd)} · cap {usd(budget?.wallet_cap_usd, 0)}
          </span>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col justify-center px-3">
        <div className="font-pixel text-[9px] uppercase tracking-wider text-ink-300">P&amp;L by strategy</div>
        <div className="flex min-w-0 flex-wrap gap-1 overflow-hidden" style={{ maxHeight: 34 }}>
          {pnl.length === 0 && <span className="text-[11px] italic text-ink-400">no strategies yet</span>}
          {pnl.slice(0, 6).map((p) => (
            <span
              key={p.opportunity_id}
              title={`${p.title} (${p.mode}): ${usd(p.total_usd)}`}
              className="inline-flex items-center gap-1 px-1 text-[10px] leading-[14px]"
              style={{ border: `2px ${p.mode === 'live' ? 'solid' : 'dashed'} ${p.mode === 'live' ? '#ff8f3f' : '#5a6fb0'}`, opacity: p.mode === 'live' ? 1 : 0.8 }}
            >
              <span className="max-w-[90px] truncate text-ink-200">{truncate(p.title, 18)}</span>
              <span style={{ color: p.total_usd > 0 ? '#6fdc8c' : p.total_usd < 0 ? '#ff5c7a' : '#b8c4ea' }}>{usdShort(p.total_usd)}</span>
            </span>
          ))}
          {pnl.length > 6 && <span className="text-[10px] text-ink-300">+{pnl.length - 6}</span>}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end justify-center gap-1 border-l-2 border-ink-700 px-3">
        <div className="flex gap-1">
          {settings?.auto_mode ? <Badge color="#6fdc8c">Auto</Badge> : <Badge color="#5a6fb0">Manual</Badge>}
          {mock && <Badge color="#c792ea">Mock</Badge>}
        </div>
        <div className="flex gap-1">
          {!live && (
            <Badge color="#8a9bd0" dashed title="Live execution is disabled until phase 6">
              Paper only
            </Badge>
          )}
          <Badge color={connected ? '#6fdc8c' : '#ff5c7a'} title={connected ? 'Connected to the factory server' : 'Reconnecting…'}>
            {connected ? '● Online' : '○ Offline'}
          </Badge>
        </div>
      </div>
    </div>
  );
}
