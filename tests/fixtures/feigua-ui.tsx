import { createRoot } from 'react-dom/client';
import { FeiguaTrends } from '../../app/feigua-trends';
import { installFeiguaPreview } from './feigua-preview.mjs';
import videoCatalog from '../../electron/feigua-video-catalog.json';

const offline = new URLSearchParams(location.search).has('offline');
installFeiguaPreview({ videoCatalog: offline ? videoCatalog : null, signedOut: offline, weeklyHistory: new URLSearchParams(location.search).has('weekly') });
createRoot(document.getElementById('root')!).render(<FeiguaTrends />);
