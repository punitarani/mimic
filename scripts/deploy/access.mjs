// Cloudflare Access in front of the lab. The app trusts the Access-authenticated email header on /lab and
// /api/lab (apps/web/lib/server.ts isAdmin), so these paths must sit behind Access on the public hostname, with
// workers.dev and preview URLs off (wrangler.jsonc) so there is no way around it. Idempotent: the app and its
// policy are found by name and updated in place.

export const ACCESS_APP_NAME = 'Mimic lab';
export const ACCESS_POLICY_NAME = 'Mimic admins';
export const LAB_PATHS = ['lab', 'lab/*', 'api/lab', 'api/lab/*'];

export function adminEmails(value) {
  const emails = (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) throw new Error('ADMIN_EMAILS is empty: nobody could reach the lab');
  for (const e of emails)
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new Error(`ADMIN_EMAILS has an invalid address`);
  return emails;
}

export function accessApp(host) {
  return {
    name: ACCESS_APP_NAME,
    type: 'self_hosted',
    domain: `${host}/lab`,
    destinations: LAB_PATHS.map((p) => ({ type: 'public', uri: `${host}/${p}` })),
    session_duration: '24h',
    app_launcher_visible: false,
  };
}

export function accessPolicy(emails) {
  return {
    name: ACCESS_POLICY_NAME,
    decision: 'allow',
    include: emails.map((email) => ({ email: { email } })),
    precedence: 1,
  };
}

export async function ensureAccess(cf, { host, emails }, log = console.log) {
  let apps;
  try {
    apps = await cf.list('/access/apps');
  } catch (e) {
    throw new Error(
      `Cloudflare Access is not available (${e.message}). Turn on Zero Trust for the account once (it picks a team ` +
        'domain), and give the API token "Access: Apps and Policies: Edit".',
    );
  }
  const body = accessApp(host);
  const existing = apps.find((a) => a.name === ACCESS_APP_NAME);
  const app = existing
    ? await cf.put(`/access/apps/${existing.id}`, body)
    : await cf.post('/access/apps', body);
  log(
    `  Access app "${ACCESS_APP_NAME}" on ${LAB_PATHS.map((p) => `/${p}`).join(', ')}: ${existing ? 'updated' : 'created'}`,
  );

  const policies = (await cf.get(`/access/apps/${app.id}/policies`)) ?? [];
  const policy = accessPolicy(emails);
  const current = policies.find((p) => p.name === ACCESS_POLICY_NAME);
  if (current) await cf.put(`/access/apps/${app.id}/policies/${current.id}`, policy);
  else await cf.post(`/access/apps/${app.id}/policies`, policy);
  log(
    `  Access policy "${ACCESS_POLICY_NAME}" (${emails.length} admin email${emails.length === 1 ? '' : 's'}): ${current ? 'updated' : 'created'}`,
  );
  return app.id;
}
