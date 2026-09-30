export const THEME_KEY = 'mimic-theme';

/** Runs in <head> before paint: applies a saved light/dark choice; "system" leaves the attribute off. */
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
