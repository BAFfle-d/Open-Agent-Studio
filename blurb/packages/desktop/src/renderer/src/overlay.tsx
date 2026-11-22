import { createRoot } from 'react-dom/client';
import { OverlayApp } from './overlay/OverlayApp';
import './overlay/overlay.css';

createRoot(document.getElementById('root')!).render(<OverlayApp />);
