import { SHARED_API } from './app-config.js';
if (SHARED_API) location.replace(new URL('./shared.html', import.meta.url));
else await import('./tracker.js');
