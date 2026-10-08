import { createRoot } from 'react-dom/client';
import { FeiguaTrends } from '../../app/feigua-trends';
import { installControlPreview } from './feigua-control-preview.mjs';

async function main() {
  await installControlPreview(new URLSearchParams(location.search).get('mode') || 'manual');
  createRoot(document.getElementById('root')!).render(<FeiguaTrends />);
}
void main();
