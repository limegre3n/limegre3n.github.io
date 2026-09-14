/**
 * Theme application (orchestrator-owned — see docs/CONTRACTS.md §9).
 * Maps config/event.theme onto CSS custom properties and data-theme-* text slots.
 * All text goes through textContent — never innerHTML (XSS guard, plan §11).
 */
const FONT_STACKS = {
  system: "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Georgia, serif",
  mono: "'Courier New', Courier, monospace",
  rounded: "'Arial Rounded MT Bold', 'Trebuchet MS', 'Segoe UI', sans-serif",
};

const HEX = /^#[0-9a-fA-F]{3,8}$/;

export function applyTheme(cfg) {
  const theme = cfg?.theme || {};
  const root = document.documentElement;
  const colors = theme.colors || {};
  if (HEX.test(colors.bg || '')) root.style.setProperty('--c-bg', colors.bg);
  if (HEX.test(colors.accent || '')) root.style.setProperty('--c-accent', colors.accent);
  if (HEX.test(colors.text || '')) root.style.setProperty('--c-text', colors.text);
  root.style.setProperty('--font-stack', FONT_STACKS[theme.font] || FONT_STACKS.system);

  const slots = {
    'couple-names': cfg?.coupleNames,
    'event-date': cfg?.eventDateText,
    'welcome-text': theme.welcomeText,
    'consent-text': theme.consentText,
    monogram: theme.monogramText,
  };
  for (const [slot, value] of Object.entries(slots)) {
    if (typeof value !== 'string') continue;
    document.querySelectorAll(`[data-theme-${slot}]`).forEach((el) => {
      el.textContent = value; // textContent only — never innerHTML
    });
  }
}
