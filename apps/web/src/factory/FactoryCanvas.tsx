import type { Agent, Stage } from '@mf/shared';
import type { JSX } from 'react';
import { useFactory } from '../store/store';

// PLACEHOLDER factory scene. The scene worker replaces this file with the
// PixiJS version; the props contract and `useFactory` reads stay the same.

type Spot = Stage | 'breakroom';

const LAYOUT: Spot[] = ['dock', 'research', 'market', 'validation', 'scrap', 'vault', 'execution', 'breakroom'];

const LABEL: Record<Spot, string> = {
  dock: 'Loading Dock',
  research: 'Research Lab',
  market: 'Market Scanner',
  validation: 'Validation Bench',
  vault: 'Vault',
  scrap: 'Scrap Heap',
  execution: 'Execution Yard',
  breakroom: 'Break Room',
};

const TINT: Record<Spot, string> = {
  dock: '#7a5a3a',
  research: '#3a6a9a',
  market: '#3a8a7a',
  validation: '#7a4a9a',
  vault: '#b8913a',
  scrap: '#7a3a3a',
  execution: '#9a6a2a',
  breakroom: '#3a4a6a',
};

const STATE_DOT: Record<Agent['state'], string> = {
  idle: '#8a9bd0',
  walking: '#6cb6ff',
  working: '#6fdc8c',
  thinking: '#c792ea',
  stuck: '#ff5c7a',
  awaiting_approval: '#ffd166',
  clocked_out: '#5a6fb0',
};

export default function FactoryCanvas(props: {
  selectedAgentId: number | null;
  onSelectAgent: (id: number) => void;
  onSelectBuilding: (stage: Stage | 'breakroom') => void;
}): JSX.Element {
  const agents = useFactory((s) => s.agents);
  const crates = useFactory((s) => s.crates);

  const agentsAt = (spot: Spot) => Object.values(agents).filter((a) => a.building === spot);
  const cratesAt = (spot: Spot) => Object.values(crates).filter((c) => c.stage === spot && (spot === 'vault' || spot === 'scrap' ? true : c.status !== 'done'));

  return (
    <div
      className="grid h-full w-full grid-cols-4 grid-rows-2 gap-3 p-3"
      style={{
        backgroundColor: '#10182e',
        backgroundImage: 'linear-gradient(#18234466 2px, transparent 2px), linear-gradient(90deg, #18234466 2px, transparent 2px)',
        backgroundSize: '32px 32px',
      }}
    >
      {LAYOUT.map((spot) => {
        const here = agentsAt(spot);
        const cs = cratesAt(spot);
        const flagged = cs.filter((c) => c.status === 'frozen' || c.status === 'stuck').length;
        return (
          <div
            key={spot}
            role="button"
            tabIndex={0}
            onClick={() => props.onSelectBuilding(spot)}
            onKeyDown={(e) => e.key === 'Enter' && props.onSelectBuilding(spot)}
            className="relative flex min-h-0 cursor-pointer flex-col overflow-hidden border-[3px] bg-ink-900/80 hover:brightness-125"
            style={{ borderColor: TINT[spot], boxShadow: `inset 0 0 0 2px #070b18, 4px 4px 0 0 rgba(0,0,0,.4)` }}
          >
            <div className="flex items-center gap-2 px-2 py-1" style={{ background: TINT[spot] }}>
              <span className="flex-1 truncate font-pixel text-[11px] uppercase text-white drop-shadow">{LABEL[spot]}</span>
              {spot !== 'breakroom' && (
                <span className="font-pixel text-[10px] text-white/90" title="crates here">
                  ▣ {cs.length}
                </span>
              )}
              {flagged > 0 && (
                <span className="font-pixel text-[10px] text-[#ff5c7a]" title="stuck or frozen crates">
                  ! {flagged}
                </span>
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
              {here.map((a) => (
                <button
                  key={a.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onSelectAgent(a.id);
                  }}
                  className={`flex items-start gap-2 border-2 bg-ink-950/80 px-1.5 py-1 text-left hover:bg-ink-800 ${props.selectedAgentId === a.id ? 'border-gold' : 'border-ink-700'}`}
                >
                  <span className="mt-[2px] inline-block h-4 w-4 shrink-0 border-2 border-black" style={{ background: a.palette }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="font-pixel text-[10px] uppercase">{a.name}</span>
                      <span className="inline-block h-2 w-2" style={{ background: STATE_DOT[a.state] }} />
                      <span className="text-[10px] text-ink-300">{a.state.replace('_', ' ')}</span>
                      {a.progress != null && <span className="ml-auto text-[10px] text-ink-300">{Math.round(a.progress * 100)}%</span>}
                    </span>
                    {a.bubble && <span className="block truncate text-[11px] italic text-ink-200">“{a.bubble}”</span>}
                  </span>
                </button>
              ))}
              {spot !== 'breakroom' && cs.length > 0 && (
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                  {cs.slice(0, 14).map((c) => (
                    <span
                      key={c.id}
                      title={`#${c.id} ${c.title} (${c.status})`}
                      className="inline-block h-3 w-3 border border-black"
                      style={{ background: c.status === 'frozen' ? '#ff5c7a' : c.status === 'stuck' ? '#ffb454' : c.priority ? '#ffd166' : '#a07a4a' }}
                    />
                  ))}
                  {cs.length > 14 && <span className="text-[10px] text-ink-300">+{cs.length - 14}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
