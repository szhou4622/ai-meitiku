import { createRoot } from 'react-dom/client';
import { FeiguaTrends } from '../../app/feigua-trends';
import { installFeiguaPreview } from './feigua-preview.mjs';

installFeiguaPreview();
createRoot(document.getElementById('root')!).render(<FeiguaTrends />);
