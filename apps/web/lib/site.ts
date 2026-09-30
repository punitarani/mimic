/**
 * Link previews (ADR-0031): every route shares one title, description and card. Mimics are self-only, so no page gets
 * a per-person preview. The origin and versions are inlined at build time (next.config.ts).
 */
export const SITE_URL = process.env.SITE_URL ?? 'http://localhost:3000';

export const SITE_TITLE = 'Mimic: a model that predicts how you decide';

/** The session's own promise ("Your mimic guesses before you answer"), so the preview claims nothing more. */
export const SITE_DESCRIPTION =
  'Answer a few quick questions. Your mimic guesses each answer before you give it, and learns how you decide.';

/** public/share-card.png, served by Workers static assets (the Worker never runs for it). */
export const SHARE_CARD = {
  url: `/share-card.png?v=${process.env.SHARE_CARD_VERSION}`,
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: 'How predictable are you? Two overlapping circles, labeled You and Mimic.',
};

/** Set in metadata rather than as app/ files, which Next would serve through the Worker. */
export const ICONS = {
  icon: { url: `/icon.svg?v=${process.env.ICON_VERSION}`, type: 'image/svg+xml' },
  apple: `/apple-touch-icon.png?v=${process.env.APPLE_ICON_VERSION}`,
};
