import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeiguaTrends } from '../../app/feigua-trends';
import { installFeiguaPreview } from './feigua-preview.mjs';
import '../../app/globals.css';
installFeiguaPreview({ musicRefreshFails: new URLSearchParams(location.search).has('fail') });
await window.desktopBridge!.feigua.start();
createRoot(document.getElementById('root')!).render(<div style={{height:'100vh',display:'flex'}}><FeiguaTrends /></div>);
