// Runs before first paint so a saved light/dark choice does not flash the other theme.
try {
  const t = localStorage.getItem('efor.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch { /* storage blocked: follow the system */ }
