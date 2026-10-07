/**
 * Les seules adresses ou Dan renvoie un code d'autorisation (revue du
 * 2026-10-07, hameconnage par redirect_uri).
 *
 * - claude.ai et claude.com : le rappel des connecteurs MCP distants.
 * - la boucle locale (localhost, 127.0.0.1, [::1]) en http, port libre :
 *   Claude Code ecoute la sur un port aleatoire. Un attaquant ne recoit rien
 *   sur la machine de l'ami sans y etre deja.
 * - GUEST_REDIRECT_URIS : adresses exactes supplementaires, separees par des
 *   virgules, si un autre client doit se brancher.
 */

const RAPPELS_CLAUDE = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

const BOUCLES_LOCALES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function redirectionAutoriseeDan(
  redirectUri: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const sansRequete = `${url.protocol}//${url.host}${url.pathname}`;
  if (RAPPELS_CLAUDE.has(sansRequete)) return true;
  if (url.protocol === 'http:' && BOUCLES_LOCALES.has(url.hostname)) return true;
  const extras = (env.GUEST_REDIRECT_URIS ?? '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
  return extras.includes(redirectUri);
}
