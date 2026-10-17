import { useEffect, useRef, useState } from 'react';
import { api, attempt } from '../net/api';
import { cratesByStage, STAGES, useFactory } from '../store/store';
import { timeOf, usd } from '../util';

// Phase 2 debug view at /debug: the pipeline as plain lists. Deliberately plain.

export default function DebugView() {
  const connected = useFactory((s) => s.connected);
  const crates = useFactory((s) => s.crates);
  const agents = useFactory((s) => s.agents);
  const feed = useFactory((s) => s.feed);
  const budget = useFactory((s) => s.budget);
  const settings = useFactory((s) => s.settings);
  const approvals = useFactory((s) => s.approvals);
  const mock = useFactory((s) => s.mock);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const byStage = cratesByStage(crates);
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [feed.length]);

  const drop = async () => {
    if (title.trim().length < 3) return;
    const ok = await attempt(() => api.dropCrate(title.trim()), setErr);
    if (ok) setTitle('');
  };

  return (
    <div className="min-h-full bg-white p-3 font-mono text-[12px] text-black">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <b>Money Factory /debug</b>
        <span>ws: {connected ? 'connected' : 'DISCONNECTED'}</span>
        {mock && <span>[MOCK]</span>}
        {settings && (
          <>
            <span>workers: {settings.worker_count}</span>
            <span>auto: {String(settings.auto_mode)}</span>
            <span>paused: {String(settings.paused)}</span>
            <span style={{ color: settings.kill_switch ? 'red' : undefined }}>kill: {String(settings.kill_switch)}</span>
          </>
        )}
        {budget && (
          <span>
            api {usd(budget.api_spent_usd, 3)} / {usd(budget.api_cap_usd)} · wallet {usd(budget.wallet_spent_usd)} / {usd(budget.wallet_cap_usd)} · paper {usd(budget.paper_spent_usd)}
          </span>
        )}
        <a href="/" className="text-blue-700 underline">
          → game UI
        </a>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="w-80 border border-gray-400 px-1" placeholder="drop a crate (title)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && drop()} />
        <button className="border border-gray-500 bg-gray-100 px-2" onClick={drop}>
          drop
        </button>
        {settings && (
          <>
            <button className="border border-gray-500 bg-gray-100 px-2" onClick={() => attempt(() => api.auto(!settings.auto_mode), setErr)}>
              auto {settings.auto_mode ? 'off' : 'on'}
            </button>
            <button className="border border-gray-500 bg-gray-100 px-2" onClick={() => attempt(() => api.pause(!settings.paused), setErr)}>
              {settings.paused ? 'resume' : 'pause'}
            </button>
            <label>
              workers{' '}
              <input type="number" min={0} max={8} className="w-12 border border-gray-400" value={settings.worker_count} onChange={(e) => attempt(() => api.putSettings({ worker_count: Number(e.target.value) }), setErr)} />
            </label>
          </>
        )}
        {err && <span className="text-red-600">{err}</span>}
      </div>

      <h3 className="font-bold">Pipeline</h3>
      <div className="mb-3 grid grid-cols-7 gap-2">
        {STAGES.map((st) => (
          <div key={st} className="min-w-0 border border-gray-300 p-1">
            <div className="font-bold">
              {st} ({byStage[st].length})
            </div>
            <ul>
              {byStage[st].map((c) => (
                <li key={c.id} className="truncate" title={`${c.title}${c.frozen_reason ? ' | frozen: ' + c.frozen_reason : ''}${c.rejection_reason ? ' | ' + c.rejection_reason : ''}`}>
                  #{c.id} <span style={{ color: c.status === 'frozen' ? 'red' : c.status === 'stuck' ? 'orange' : c.status === 'in_progress' ? 'blue' : 'gray' }}>[{c.status}]</span>
                  {c.priority ? ' ★' : ''} {c.title}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <h3 className="font-bold">Agents</h3>
          <table className="w-full">
            <tbody>
              {Object.values(agents).map((a) => (
                <tr key={a.id} className="border-b border-gray-200">
                  <td>#{a.id}</td>
                  <td>{a.name}</td>
                  <td>L{a.level}</td>
                  <td>{a.state}</td>
                  <td>{a.building}</td>
                  <td>{a.current_role ?? ''}</td>
                  <td>{a.current_crate_id ? `crate ${a.current_crate_id}` : a.current_opportunity_id ? `opp ${a.current_opportunity_id}` : ''}</td>
                  <td className="max-w-40 truncate">{a.bubble}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-3 font-bold">Pending approvals ({Object.keys(approvals).length})</h3>
          <ul>
            {Object.values(approvals).map((a) => (
              <li key={a.id}>
                #{a.id} {a.server}/{a.tool} {usd(a.amount_usd)} T{a.tier} ({a.mode}){' '}
                <button className="border border-gray-500 px-1" onClick={() => attempt(() => api.approve(a.id), setErr)}>
                  approve
                </button>{' '}
                <button className="border border-gray-500 px-1" onClick={() => attempt(() => api.reject(a.id), setErr)}>
                  reject
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="col-span-2">
          <h3 className="font-bold">Live feed ({feed.length})</h3>
          <div ref={feedRef} className="h-80 overflow-y-auto border border-gray-300 p-1">
            {feed.map((f) => (
              <div key={f.id} style={{ color: f.level === 'bad' ? 'red' : f.level === 'warn' ? '#b36b00' : f.level === 'good' ? 'green' : undefined }}>
                {timeOf(f.ts)} [{f.level}] {f.text} {f.ref && <span className="text-gray-500">({f.ref})</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
