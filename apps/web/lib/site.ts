/**
 * The public origin: prod's custom domain (wrangler.jsonc, `env.prod.routes`). Link previews need absolute image
 * URLs, and without a base Next resolves them against localhost. Preview and dev point at prod's copy of the same
 * static image.
 */
export const SITE_URL = 'https://mimic.punitarani.com';

export const SITE_TITLE = 'Mimic: a model that predicts how you decide';

/** The session's own promise ("Your mimic guesses before you answer"), so the preview claims nothing more. */
export const SITE_DESCRIPTION =
  'Answer a few quick questions. Your mimic guesses each answer before you give it, and learns how you decide.';
