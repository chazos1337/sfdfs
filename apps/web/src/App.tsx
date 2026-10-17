import DebugView from './views/DebugView';
import MainView from './views/MainView';

// No router library: `/debug` gets the plain pipeline lists, everything else the game UI.
export default function App() {
  const path = typeof location !== 'undefined' ? location.pathname : '/';
  if (path.replace(/\/+$/, '') === '/debug') return <DebugView />;
  return <MainView />;
}
